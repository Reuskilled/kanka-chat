package com.kanka.chat;

import android.Manifest;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Build;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.util.List;

/**
 * Kanka sesli oda köprüsü (Android).
 *  start({ baslik, metin })  : ön plan hizmetini başlatır (uygulama arka plandayken mikrofon kapanmasın), ses iletişim moduna geçer
 *  stop()                    : hizmeti ve iletişim modunu kapatır
 *  routes()                  : kullanılabilir ses çıkışları { cikislar: [{ id, tur, ad }], secili }
 *  setRoute({ tur })          : 'hoparlor' | 'ahize' | 'bluetooth' | 'kablolu'
 *  olay 'ayril'              : bildirimdeki "Ayrıl" butonuna basıldı
 *  olay 'cikis'              : ses çıkışı değişti (kulaklık takıldı / çıkarıldı)
 */
@CapacitorPlugin(name = "KankaSes", permissions = { @Permission(alias = "bluetooth", strings = { Manifest.permission.BLUETOOTH_CONNECT }) })
public class KankaSesPlugin extends Plugin {
    static KankaSesPlugin last;
    private AudioManager am;
    private boolean active = false;
    private String chosen = null; // kullanıcının seçtiği çıkış türü
    private Object deviceCb;

    private final BroadcastReceiver leaveRx = new BroadcastReceiver() {
        @Override public void onReceive(Context c, Intent i) { notifyListeners("ayril", new JSObject()); }
    };

    @Override
    public void load() {
        last = this;
        am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        IntentFilter f = new IntentFilter(KankaSesService.ACTION_LEAVE_TO_APP);
        ContextCompat.registerReceiver(getContext(), leaveRx, f, ContextCompat.RECEIVER_NOT_EXPORTED);
        if (Build.VERSION.SDK_INT >= 23) {
            android.media.AudioDeviceCallback cb = new android.media.AudioDeviceCallback() {
                @Override public void onAudioDevicesAdded(AudioDeviceInfo[] d) { onDevicesChanged(); }
                @Override public void onAudioDevicesRemoved(AudioDeviceInfo[] d) { onDevicesChanged(); }
            };
            deviceCb = cb;
            am.registerAudioDeviceCallback(cb, null);
        }
    }

    @Override
    protected void handleOnDestroy() {
        try { getContext().unregisterReceiver(leaveRx); } catch (Exception ignored) {}
        if (Build.VERSION.SDK_INT >= 23 && deviceCb != null) am.unregisterAudioDeviceCallback((android.media.AudioDeviceCallback) deviceCb);
        stopAll();
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 31 && getPermissionState("bluetooth") != PermissionState.GRANTED && !call.getBoolean("izinSorma", false)) {
            requestPermissionForAlias("bluetooth", call, "afterBt");
            return;
        }
        doStart(call);
    }

    @PermissionCallback
    private void afterBt(PluginCall call) { doStart(call); }

    private void doStart(PluginCall call) {
        Intent i = new Intent(getContext(), KankaSesService.class);
        i.putExtra("baslik", call.getString("baslik", "Sesli odadasın"));
        i.putExtra("metin", call.getString("metin", "Kanka Chat · dokun, uygulamaya dön"));
        try { ContextCompat.startForegroundService(getContext(), i); } catch (Exception e) { call.reject("Hizmet başlatılamadı: " + e.getMessage()); return; }
        am.setMode(AudioManager.MODE_IN_COMMUNICATION);
        active = true;
        applyRoute(chosen != null ? chosen : defaultRoute());
        call.resolve(state());
    }

    @PluginMethod
    public void stop(PluginCall call) { stopAll(); call.resolve(); }

    private void stopAll() {
        if (!active) return;
        active = false;
        try { getContext().stopService(new Intent(getContext(), KankaSesService.class)); } catch (Exception ignored) {}
        if (Build.VERSION.SDK_INT >= 31) am.clearCommunicationDevice();
        else { am.setSpeakerphoneOn(false); if (am.isBluetoothScoOn()) { am.stopBluetoothSco(); am.setBluetoothScoOn(false); } }
        am.setMode(AudioManager.MODE_NORMAL);
    }

    @PluginMethod
    public void routes(PluginCall call) { call.resolve(state()); }

    @PluginMethod
    public void setRoute(PluginCall call) {
        String t = call.getString("tur");
        if (t == null) { call.reject("tur gerekli"); return; }
        chosen = t;
        if (active) applyRoute(t);
        call.resolve(state());
    }

    private void onDevicesChanged() {
        if (!active) return;
        // Seçilen çıkış gittiyse (kulaklık çıkarıldı) varsayılana dön; yeni kulaklık takıldıysa ona geç
        String def = defaultRoute();
        if (chosen == null || !available(chosen) || ("bluetooth".equals(def) || "kablolu".equals(def))) { chosen = null; applyRoute(def); }
        notifyListeners("cikis", state());
    }

    private String typeOf(int t) {
        switch (t) {
            case AudioDeviceInfo.TYPE_BUILTIN_SPEAKER: return "hoparlor";
            case AudioDeviceInfo.TYPE_BUILTIN_EARPIECE: return "ahize";
            case AudioDeviceInfo.TYPE_BLUETOOTH_SCO: return "bluetooth";
            case AudioDeviceInfo.TYPE_WIRED_HEADSET: case AudioDeviceInfo.TYPE_WIRED_HEADPHONES: case AudioDeviceInfo.TYPE_USB_HEADSET: return "kablolu";
            default:
                if (Build.VERSION.SDK_INT >= 31 && t == AudioDeviceInfo.TYPE_BLE_HEADSET) return "bluetooth";
                return null;
        }
    }

    private boolean available(String tur) {
        if ("hoparlor".equals(tur)) return true;
        if (Build.VERSION.SDK_INT >= 31) { for (AudioDeviceInfo d : am.getAvailableCommunicationDevices()) if (tur.equals(typeOf(d.getType()))) return true; return false; }
        if ("ahize".equals(tur)) return getContext().getPackageManager().hasSystemFeature("android.hardware.telephony");
        if (Build.VERSION.SDK_INT >= 23) for (AudioDeviceInfo d : am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) if (tur.equals(typeOf(d.getType()))) return true;
        return false;
    }

    private String defaultRoute() {
        if (available("bluetooth")) return "bluetooth";
        if (available("kablolu")) return "kablolu";
        return "hoparlor"; // sesli odalar için varsayılan hoparlör (ahize kulağa tutulan aramalar içindir)
    }

    private void applyRoute(String tur) {
        if (Build.VERSION.SDK_INT >= 31) {
            for (AudioDeviceInfo d : am.getAvailableCommunicationDevices()) if (tur.equals(typeOf(d.getType()))) { am.setCommunicationDevice(d); return; }
            return;
        }
        boolean bt = "bluetooth".equals(tur);
        if (bt) { am.setSpeakerphoneOn(false); am.startBluetoothSco(); am.setBluetoothScoOn(true); }
        else { if (am.isBluetoothScoOn()) { am.stopBluetoothSco(); am.setBluetoothScoOn(false); } am.setSpeakerphoneOn("hoparlor".equals(tur)); }
    }

    private JSObject state() {
        JSObject o = new JSObject();
        JSArray list = new JSArray();
        java.util.LinkedHashSet<String> seen = new java.util.LinkedHashSet<>();
        if (Build.VERSION.SDK_INT >= 31) {
            List<AudioDeviceInfo> ds = am.getAvailableCommunicationDevices();
            for (AudioDeviceInfo d : ds) { String t = typeOf(d.getType()); if (t != null && seen.add(t)) { JSObject x = new JSObject(); x.put("tur", t); x.put("ad", d.getProductName() != null ? d.getProductName().toString() : t); list.put(x); } }
            AudioDeviceInfo cur = am.getCommunicationDevice();
            o.put("secili", cur != null ? typeOf(cur.getType()) : null);
        } else {
            for (String t : new String[] { "hoparlor", "ahize", "bluetooth", "kablolu" }) if (available(t) && seen.add(t)) { JSObject x = new JSObject(); x.put("tur", t); x.put("ad", t); list.put(x); }
            o.put("secili", am.isBluetoothScoOn() ? "bluetooth" : am.isSpeakerphoneOn() ? "hoparlor" : available("kablolu") ? "kablolu" : "ahize");
        }
        o.put("cikislar", list);
        o.put("aktif", active);
        return o;
    }
}
