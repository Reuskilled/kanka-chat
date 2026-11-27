"""
Kanka Chat - Yapay Zeka (AI) Saydam Video & Gorsel Motoru (IS-Net + DirectML GPU)
Yesil perde olmadan herhangi bir videoyu (MP4/MOV/WEBM) veya gorseli (PNG/JPG)
gercek Alpha kanalli (yuva420p) saydam .webm / .png ciktisina cevirir.

Kullanim:
  python ai-saydam.py girdi.mp4 [cikti.webm] [--mode auto|general|black-vfx] [--fps 24] [--max-w 540] [--crop-bottom 0.0]
"""

import argparse
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image

DEFAULT_MODEL = Path(r"C:\Users\pisago\.gemini\antigravity\scratch\kanka-ai-venv\models\isnet-general-use.onnx")
FALLBACK_FFMPEG = Path(
    r"C:\Users\pisago\.gemini\antigravity\brain\52b6f74c-0c62-4fdb-9c06-18dfed4d4f4c\scratch\ff\node_modules\ffmpeg-static\ffmpeg.exe"
)


def find_ffmpeg() -> str:
    found = shutil.which("ffmpeg")
    if found:
        return found
    if FALLBACK_FFMPEG.exists():
        return str(FALLBACK_FFMPEG)
    raise FileNotFoundError("ffmpeg bulunamadi. PATH'e ekleyin veya ffmpeg-static kurun.")


def probe_video(ffmpeg: str, src: Path) -> tuple[int, int, float, float]:
    cmd = [ffmpeg, "-i", str(src)]
    res = subprocess.run(cmd, stderr=subprocess.PIPE, stdout=subprocess.DEVNULL, text=True, encoding="utf-8", errors="ignore")
    w, h, fps, dur = 0, 0, 24.0, 5.0
    import re
    for line in res.stderr.splitlines():
        if "Duration:" in line:
            m_d = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", line)
            if m_d:
                dur = int(m_d.group(1)) * 3600 + int(m_d.group(2)) * 60 + float(m_d.group(3))
        if "Video:" in line:
            m_dim = re.search(r",\s*(\d{2,5})x(\d{2,5})(?:\s|,|\[)", line)
            if m_dim:
                w, h = int(m_dim.group(1)), int(m_dim.group(2))
            m_fps = re.search(r"(\d+(?:\.\d+)?)\s*fps", line)
            if m_fps:
                fps = float(m_fps.group(1))
            break
    if not w or not h:
        raise RuntimeError(f"Video cozunurlugu okunamadi: {src}")
    return w, h, fps, dur


def load_session(model_path: Path, use_cpu: bool = False) -> tuple[ort.InferenceSession, str, tuple[int, int]]:
    if not model_path.exists():
        raise FileNotFoundError(f"AI modeli bulunamadi: {model_path}")
    opts = ort.SessionOptions()
    opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    avail = ort.get_available_providers()
    providers = ["CPUExecutionProvider"]
    if not use_cpu and "DmlExecutionProvider" in avail:
        providers = ["DmlExecutionProvider", "CPUExecutionProvider"]
    elif not use_cpu and "CUDAExecutionProvider" in avail:
        providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]
    sess = ort.InferenceSession(str(model_path), sess_options=opts, providers=providers)
    inp = sess.get_inputs()[0]
    shape = inp.shape
    in_h = int(shape[2]) if isinstance(shape[2], int) else 1024
    in_w = int(shape[3]) if isinstance(shape[3], int) else 1024
    return sess, inp.name, (in_w, in_h)


def infer_alpha(sess: ort.InferenceSession, input_name: str, in_size: tuple[int, int], rgb_arr: np.ndarray) -> np.ndarray:
    h, w = rgb_arr.shape[:2]
    im = Image.fromarray(rgb_arr, mode="RGB").resize(in_size, Image.Resampling.BILINEAR)
    x = np.asarray(im, dtype=np.float32) / 255.0
    x = (x - 0.5) / 1.0
    x = np.transpose(x, (2, 0, 1))[None, ...]  # 1, 3, H, W
    out = sess.run(None, {input_name: x})[0]
    mask = np.squeeze(out).astype(np.float32)
    # IS-Net outputs sigmoid in [0, 1]; guard against raw logits just in case
    if mask.min() < -0.1 or mask.max() > 1.1:
        mask = 1.0 / (1.0 + np.exp(-np.clip(mask, -20.0, 20.0)))
    mask = np.clip(mask, 0.0, 1.0)
    mask_u8 = (mask * 255.0 + 0.5).astype(np.uint8)
    mask_resized = Image.fromarray(mask_u8, mode="L").resize((w, h), Image.Resampling.BILINEAR)
    return np.asarray(mask_resized, dtype=np.float32) / 255.0


def smoothstep(edge0: float, edge1: float, x: np.ndarray) -> np.ndarray:
    t = np.clip((x - edge0) / (edge1 - edge0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def detect_black_bg(rgb_arr: np.ndarray) -> bool:
    h, w = rgb_arr.shape[:2]
    b = max(6, min(h, w) // 25)
    tb = np.concatenate([rgb_arr[:b, :, :].reshape(-1, 3), rgb_arr[-b:, :, :].reshape(-1, 3)], axis=0)
    lr = np.concatenate([rgb_arr[:, :b, :].reshape(-1, 3), rgb_arr[:, -b:, :].reshape(-1, 3)], axis=0)
    # Require pure black in image interior AND on both vertical/horizontal edges (prevents false trigger on letterboxed green screen)
    return (
        float(np.percentile(rgb_arr.max(axis=2), 35)) < 14.0
        and float(np.percentile(tb.max(axis=1), 40)) < 18.0
        and float(np.percentile(lr.max(axis=1), 40)) < 18.0
    )


def compose_rgba(
    rgb_arr: np.ndarray,
    ai_alpha: np.ndarray,
    black_vfx: bool,
    mask_kling_corner: bool = False,
    mask_dreamina: bool = False,
    keep_dark: bool = False,
    opacity_scale: float = 1.0,
) -> np.ndarray:
    rgb_f = rgb_arr.astype(np.float32)
    # Clean near-zero matte noise while preserving soft edge antialiasing
    solid = smoothstep(0.10, 0.85, ai_alpha)

    if black_vfx:
        # Rescue emissive fire, sparks, magic aura, smoke on pure black background
        max_c = rgb_f.max(axis=2) / 255.0
        min_c = rgb_f.min(axis=2) / 255.0
        chroma = max_c - min_c
        # Punch out trapped pure #000000 background holes inside coils/loops (skip for 2D anime with black outlines/eyes)
        if not keep_dark:
            solid = solid * smoothstep(0.012, 0.045, max_c)
        # Emissive glow = bright pixels OR warm/colorful fire embers
        glow_energy = np.maximum(max_c, chroma * 1.10)
        glow_alpha = smoothstep(0.11, 0.56, glow_energy)

        # Combine: 100% solid AI subject + silky translucent emissive glow
        alpha = np.maximum(solid, glow_alpha)

        # Un-premultiply pure black fringe in glow/edge areas so fire/glow stays vivid on both dark and light cards
        glow_only = np.clip(alpha - solid, 0.0, 1.0)
        if np.any(glow_only > 0.01):
            denom = np.maximum(alpha, 0.28)[..., None]
            unpremul = np.clip(rgb_f / denom, 0.0, 255.0)
            blend = (glow_only / np.maximum(alpha, 1e-4))[..., None]
            rgb_f = rgb_f * (1.0 - blend) + unpremul * blend
    else:
        alpha = solid

    if mask_kling_corner:
        # Cleanly erase bottom-right KlingAI white/grey watermark without cutting a hard notch into orange flames
        h, w = alpha.shape
        y0 = int(h * 0.942)
        x0 = int(w * 0.67)
        patch = rgb_f[y0:, x0:] / 255.0
        p_chroma = patch.max(axis=2) - patch.min(axis=2)
        wm_mask = smoothstep(0.16, 0.06, p_chroma)
        alpha[y0:, x0:] *= (1.0 - wm_mask)

    if mask_dreamina:
        # Erase top-left [AI] badge completely (Dreamina bottom watermark is handled via --crop-bottom 0.045)
        h, w = alpha.shape
        alpha[:int(h * 0.055), :int(w * 0.10)] = 0.0

    if opacity_scale < 0.999:
        alpha = alpha * max(0.0, min(1.0, opacity_scale))

    # Zero out completely transparent pixels for cleaner VP9 compression
    rgb_f = np.where(alpha[..., None] < 0.01, 0.0, rgb_f)
    alpha = np.where(alpha < 0.01, 0.0, alpha)

    rgba = np.empty((rgb_arr.shape[0], rgb_arr.shape[1], 4), dtype=np.uint8)
    rgba[..., :3] = np.clip(rgb_f + 0.5, 0, 255).astype(np.uint8)
    rgba[..., 3] = np.clip(alpha * 255.0 + 0.5, 0, 255).astype(np.uint8)
    return rgba


def process_image(src: Path, dst: Path, sess, input_name, in_size, mode: str, mask_wm: bool = False, mask_dreamina: bool = False, keep_dark: bool = False):
    im = Image.open(src).convert("RGB")
    rgb = np.asarray(im, dtype=np.uint8)
    black_vfx = (mode == "black-vfx") or (mode == "auto" and detect_black_bg(rgb))
    print(f"[AI] Gorsel isleniyor ({rgb.shape[1]}x{rgb.shape[0]}, mod={'black-vfx' if black_vfx else 'general'})...")
    ai_alpha = infer_alpha(sess, input_name, in_size, rgb)
    rgba = compose_rgba(rgb, ai_alpha, black_vfx, mask_kling_corner=mask_wm, mask_dreamina=mask_dreamina, keep_dark=keep_dark)
    Image.fromarray(rgba, mode="RGBA").save(dst)
    print(f"[OK] Kaydedildi: {dst} ({dst.stat().st_size / 1024:.1f} KB)")


def process_video(
    src: Path,
    dst: Path,
    sess,
    input_name,
    in_size,
    mode: str,
    target_fps: float,
    max_w: int,
    crop_bottom: float,
    crf: int,
    mask_wm: bool = False,
    mask_dreamina: bool = False,
    keep_dark: bool = False,
    fade_in: float = 0.0,
    fade_out: float = 0.0,
    tail_pause: float = 0.0,
):
    ffmpeg = find_ffmpeg()
    orig_w, orig_h, orig_fps, dur = probe_video(ffmpeg, src)
    fps = target_fps if target_fps > 0 else min(orig_fps, 24.0)
    est_frames = max(1, int(round(dur * fps)))

    # Compute output dimensions (even numbers required by VP9 yuva420p)
    crop_h = int(orig_h * (1.0 - crop_bottom))
    crop_h = max(64, crop_h - (crop_h % 2))
    out_w = min(orig_w, max_w) if max_w > 0 else orig_w
    out_w = max(64, out_w - (out_w % 2))
    out_h = int(round(crop_h * (out_w / orig_w)))
    out_h = max(64, out_h - (out_h % 2))

    vf_parts = []
    if crop_bottom > 0.001:
        vf_parts.append(f"crop={orig_w}:{crop_h}:0:0")
    if out_w != orig_w or out_h != crop_h:
        vf_parts.append(f"scale={out_w}:{out_h}:flags=lanczos")
    vf_parts.append(f"fps={fps:.3f}")
    vf = ",".join(vf_parts)

    dec_cmd = [
        ffmpeg, "-v", "error", "-i", str(src),
        "-vf", vf,
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-"
    ]
    enc_cmd = [
        ffmpeg, "-v", "error", "-y",
        "-f", "rawvideo", "-pix_fmt", "rgba",
        "-s", f"{out_w}x{out_h}", "-r", f"{fps:.3f}",
        "-i", "-",
        "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p",
        "-b:v", "0", "-crf", str(crf),
        "-deadline", "good", "-cpu-used", "2",
        "-auto-alt-ref", "0", "-an",
        str(dst),
    ]

    print(f"[AI] Video: {src.name} ({orig_w}x{orig_h} @ {orig_fps:.1f}fps, {dur:.2f}s) -> {out_w}x{out_h} @ {fps:.1f}fps")
    dec = subprocess.Popen(dec_cmd, stdout=subprocess.PIPE)
    enc = subprocess.Popen(enc_cmd, stdin=subprocess.PIPE)

    frame_bytes = out_w * out_h * 3
    idx = 0
    black_vfx = None
    prev_alpha = None
    t0 = time.time()

    try:
        while True:
            raw = dec.stdout.read(frame_bytes)
            if len(raw) < frame_bytes:
                break
            rgb = np.frombuffer(raw, dtype=np.uint8).reshape((out_h, out_w, 3))
            if black_vfx is None:
                black_vfx = (mode == "black-vfx") or (mode == "auto" and detect_black_bg(rgb))
                print(f"[AI] Mod: {'black-vfx (AI govde + alev/parilti koruma)' if black_vfx else 'general (AI tam arka plan silme)'}")

            ai_alpha = infer_alpha(sess, input_name, in_size, rgb)
            # Subtle temporal stabilization on semi-transparent edges to prevent shimmer
            if prev_alpha is not None:
                diff = np.abs(ai_alpha - prev_alpha)
                stable = np.where(diff < 0.14, 0.78 * ai_alpha + 0.22 * prev_alpha, ai_alpha)
            else:
                stable = ai_alpha
            prev_alpha = ai_alpha

            # Smooth fade-in / fade-out envelope for seamless loop
            t_cur = idx / fps
            op = 1.0
            if fade_in > 0.01 and t_cur < fade_in:
                u = max(0.0, min(1.0, t_cur / fade_in))
                op *= u * u * (3.0 - 2.0 * u)
            if fade_out > 0.01:
                rem = max(0.0, (est_frames - 1 - idx) / fps)
                if rem < fade_out:
                    u = max(0.0, min(1.0, rem / fade_out))
                    op *= u * u * (3.0 - 2.0 * u)

            rgba = compose_rgba(
                rgb,
                stable,
                black_vfx,
                mask_kling_corner=mask_wm,
                mask_dreamina=mask_dreamina,
                keep_dark=keep_dark,
                opacity_scale=op,
            )
            enc.stdin.write(rgba.tobytes())
            idx += 1
            if idx % 10 == 0:
                dt = time.time() - t0
                print(f"  kare {idx} ({idx / max(dt, 0.1):.2f} kare/sn)...", flush=True)

        # Optional fully transparent breath pause at the end before seamless loop restarts
        if tail_pause > 0.01:
            n_empty = int(round(tail_pause * fps))
            empty = bytes(out_w * out_h * 4)
            for _ in range(n_empty):
                enc.stdin.write(empty)
                idx += 1
    finally:
        if dec.stdout:
            dec.stdout.close()
        if enc.stdin:
            enc.stdin.close()
        dec.wait()
        enc.wait()

    dt = time.time() - t0
    if enc.returncode != 0 or not dst.exists():
        raise RuntimeError(f"VP9 encode hatasi (kod {enc.returncode})")
    size_mb = dst.stat().st_size / (1024 * 1024)
    print(f"[OK] {idx} kare {dt:.1f} sn icinde islendi -> {dst} ({size_mb:.2f} MB)")


def main():
    p = argparse.ArgumentParser(description="Kanka Chat AI Saydam Video/Gorsel Donusturucu")
    p.add_argument("input", help="Girdi video (.mp4/.mov/.webm) veya gorsel (.png/.jpg)")
    p.add_argument("output", nargs="?", help="Cikti yolu (.webm veya .png)")
    p.add_argument("--mode", choices=["auto", "general", "black-vfx"], default="auto")
    p.add_argument("--fps", type=float, default=20.0, help="Hedef FPS (0 = orijinal, varsayilan 20)")
    p.add_argument("--max-w", type=int, default=540, help="Maksimum genislik (varsayilan 540)")
    p.add_argument("--crop-bottom", type=float, default=-1.0, help="Alttan kirpma orani (or: 0.045 = %%4.5, -1 = dreamina icin oto)")
    p.add_argument("--mask-watermark", action="store_true", help="Sag alt kosedeki KlingAI logosunu sil")
    p.add_argument("--mask-dreamina", action="store_true", help="Sol ust [AI] rozetini ve Dreamina filigranini sil")
    p.add_argument("--keep-dark", action="store_true", help="2D anime siyah cizgileri ve gozleri koru")
    p.add_argument("--fade-in", type=float, default=0.0, help="Baslangic yumusak giris suresi (sn)")
    p.add_argument("--fade-out", type=float, default=0.0, help="Son saniyede yumusak yok olma suresi (sn)")
    p.add_argument("--tail-pause", type=float, default=0.0, help="Loop oncesi saydam bekleme suresi (sn)")
    p.add_argument("--crf", type=int, default=28, help="VP9 kalite (dusuk = daha net, varsayilan 28)")
    p.add_argument("--model", default=str(DEFAULT_MODEL), help="ONNX model yolu")
    p.add_argument("--cpu", action="store_true", help="GPU yerine CPU kullan")
    args = p.parse_args()

    src = Path(args.input).resolve()
    if not src.exists():
        print(f"[HATA] Dosya bulunamadi: {src}", file=sys.stderr)
        sys.exit(1)

    is_img = src.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp", ".bmp"}
    if args.output:
        dst = Path(args.output).resolve()
    else:
        ext = ".png" if is_img else ".webm"
        dst = src.with_name(f"{src.stem}_saydam{ext}")

    lname = src.name.lower()
    mask_wm = args.mask_watermark or ("kling" in lname)
    mask_dr = args.mask_dreamina or ("dreamina" in lname)
    crop_bottom = args.crop_bottom
    if crop_bottom < 0:
        crop_bottom = 0.045 if mask_dr else 0.0

    sess, input_name, in_size = load_session(Path(args.model), use_cpu=args.cpu)
    print(f"[AI] Motor hazir: {sess.get_providers()[0]} | Model: {Path(args.model).name}")

    if is_img:
        process_image(src, dst, sess, input_name, in_size, args.mode, mask_wm=mask_wm, mask_dreamina=mask_dr, keep_dark=args.keep_dark)
    else:
        process_video(
            src, dst, sess, input_name, in_size, args.mode, args.fps, args.max_w, crop_bottom, args.crf,
            mask_wm=mask_wm, mask_dreamina=mask_dr, keep_dark=args.keep_dark,
            fade_in=args.fade_in, fade_out=args.fade_out, tail_pause=args.tail_pause,
        )


if __name__ == "__main__":
    main()
