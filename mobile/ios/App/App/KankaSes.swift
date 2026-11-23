import Foundation
import AVFoundation
import Capacitor

/// Kendi eklentilerimizi Capacitor'a tanıtan ana görünüm (Main.storyboard bunu kullanır)
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(KankaSesPlugin())
    }
}

/// Kanka sesli oda köprüsü (iOS): ses oturumu, hoparlör / ahize / Bluetooth / kulaklık seçimi.
/// Not: iOS, WKWebView'ın mikrofonunu uygulama arka plana geçince durdurur; arka planda konuşmaya devam etmek yerel WebRTC gerektirir.
@objc(KankaSesPlugin)
public class KankaSesPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "KankaSesPlugin"
    public let jsName = "KankaSes"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "routes", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setRoute", returnType: CAPPluginReturnPromise),
    ]
    private var active = false
    private var chosen: String?

    override public func load() {
        NotificationCenter.default.addObserver(self, selector: #selector(routeChanged(_:)), name: AVAudioSession.routeChangeNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(interrupted(_:)), name: AVAudioSession.interruptionNotification, object: nil)
    }

    private func configure() throws {
        let s = AVAudioSession.sharedInstance()
        try s.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetooth, .allowBluetoothA2DP, .defaultToSpeaker])
        try s.setActive(true)
    }

    @objc func start(_ call: CAPPluginCall) {
        do { try configure(); active = true; apply(chosen ?? defaultRoute()); call.resolve(state()) }
        catch { call.reject("Ses oturumu açılamadı: \(error.localizedDescription)") }
    }

    @objc func stop(_ call: CAPPluginCall) {
        active = false
        let s = AVAudioSession.sharedInstance()
        try? s.overrideOutputAudioPort(.none)
        try? s.setActive(false, options: .notifyOthersOnDeactivation)
        call.resolve()
    }

    @objc func routes(_ call: CAPPluginCall) { call.resolve(state()) }

    @objc func setRoute(_ call: CAPPluginCall) {
        guard let t = call.getString("tur") else { call.reject("tur gerekli"); return }
        chosen = t
        if active { apply(t) }
        call.resolve(state())
    }

    private func typeOf(_ p: AVAudioSession.Port) -> String? {
        switch p {
        case .builtInSpeaker: return "hoparlor"
        case .builtInReceiver, .builtInMic: return "ahize"
        case .bluetoothHFP, .bluetoothA2DP, .bluetoothLE: return "bluetooth"
        case .headphones, .headsetMic, .usbAudio: return "kablolu"
        default: return nil
        }
    }

    private func inputs() -> [AVAudioSessionPortDescription] { AVAudioSession.sharedInstance().availableInputs ?? [] }

    private func defaultRoute() -> String {
        if inputs().contains(where: { typeOf($0.portType) == "bluetooth" }) { return "bluetooth" }
        if inputs().contains(where: { typeOf($0.portType) == "kablolu" }) { return "kablolu" }
        return "hoparlor"
    }

    private func apply(_ t: String) {
        let s = AVAudioSession.sharedInstance()
        do {
            switch t {
            case "hoparlor":
                try s.setPreferredInput(inputs().first(where: { $0.portType == .builtInMic }))
                try s.overrideOutputAudioPort(.speaker)
            case "ahize":
                try s.overrideOutputAudioPort(.none)
                try s.setPreferredInput(inputs().first(where: { $0.portType == .builtInMic }))
            default:
                try s.overrideOutputAudioPort(.none)
                if let p = inputs().first(where: { typeOf($0.portType) == t }) { try s.setPreferredInput(p) }
            }
        } catch { CAPLog.print("KankaSes yönlendirme: \(error)") }
    }

    private func state() -> [String: Any] {
        let s = AVAudioSession.sharedInstance()
        var list: [[String: Any]] = [["tur": "hoparlor", "ad": "Hoparlör"]]
        if UIDevice.current.userInterfaceIdiom == .phone { list.append(["tur": "ahize", "ad": "Telefon"]) }
        for p in inputs() { if let t = typeOf(p.portType), t != "ahize", !list.contains(where: { ($0["tur"] as? String) == t }) { list.append(["tur": t, "ad": p.portName]) } }
        let out = s.currentRoute.outputs.first.flatMap { typeOf($0.portType) }
        return ["cikislar": list, "secili": out ?? NSNull(), "aktif": active]
    }

    @objc private func routeChanged(_ n: Notification) {
        guard active else { return }
        if let r = n.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt, let reason = AVAudioSession.RouteChangeReason(rawValue: r), reason == .newDeviceAvailable || reason == .oldDeviceUnavailable {
            chosen = nil
            apply(defaultRoute())
        }
        notifyListeners("cikis", data: state())
    }

    @objc private func interrupted(_ n: Notification) {
        guard active, let r = n.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt, AVAudioSession.InterruptionType(rawValue: r) == .ended else { return }
        try? configure(); apply(chosen ?? defaultRoute()) // telefon araması bitince sesi geri aç
    }
}
