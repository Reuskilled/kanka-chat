import Foundation
import UIKit
import PushKit
import CallKit
import Capacitor

/// Gelen aramalar (iOS): PushKit VoIP bildirimi gelince iPhone'un kendi arama ekranı (CallKit) çalar.
/// Uygulama kapalıyken bile çalışır. Cevapla / Reddet, web arayüzüne `callAction` olayıyla iletilir;
/// arayüz henüz yüklenmediyse (uygulama kapalıydı) eylem bekletilir ve `pending()` ile alınır.
///
/// Apple kuralı: her VoIP bildirimi hemen bir arama olarak bildirilmelidir (reportNewIncomingCall),
/// yoksa iOS uygulamayı kapatır ve VoIP bildirimlerini keser. Bu yüzden gelen her VoIP bildirimi bir arama olur.
final class KankaCallManager: NSObject, PKPushRegistryDelegate, CXProviderDelegate {
    static let shared = KankaCallManager()

    private var registry: PKPushRegistry?
    private let provider: CXProvider
    private let controller = CXCallController()
    private var calls: [UUID: [String: Any]] = [:]   // CallKit arama kimliği -> arama bilgisi (chId, from, title, video)
    private var timers: [UUID: Timer] = [:]
    private(set) var voipToken: String?
    private(set) var pending: [[String: Any]] = []    // arayüz yüklenmeden yapılan cevapla/reddet eylemleri
    weak var plugin: KankaCallPlugin?

    private override init() {
        let cfg: CXProviderConfiguration
        if #available(iOS 14.0, *) { cfg = CXProviderConfiguration() } else { cfg = CXProviderConfiguration(localizedName: "Kanka Chat") }
        cfg.supportsVideo = true
        cfg.maximumCallsPerCallGroup = 1
        cfg.maximumCallGroups = 1
        cfg.supportedHandleTypes = [.generic]
        cfg.includesCallsInRecents = false   // DM aramaları telefonun "Son aramalar" listesine düşmesin
        provider = CXProvider(configuration: cfg)
        super.init()
        provider.setDelegate(self, queue: nil)
    }

    /// AppDelegate açılışta çağırır: uygulama kapalıyken gelen VoIP bildirimini alabilmek için kayıt hemen yapılmalı.
    func start() {
        guard registry == nil else { return }
        let r = PKPushRegistry(queue: .main)
        r.delegate = self
        r.desiredPushTypes = [.voIP]
        registry = r
    }

    // MARK: PushKit
    func pushRegistry(_ registry: PKPushRegistry, didUpdate pushCredentials: PKPushCredentials, for type: PKPushType) {
        guard type == .voIP else { return }
        voipToken = pushCredentials.token.map { String(format: "%02x", $0) }.joined()
        plugin?.emit("voipToken", ["token": voipToken ?? ""])
    }

    func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
        if type == .voIP { voipToken = nil }
    }

    func pushRegistry(_ registry: PKPushRegistry, didReceiveIncomingPushWith payload: PKPushPayload, for type: PKPushType, completion: @escaping () -> Void) {
        guard type == .voIP else { completion(); return }
        let k = payload.dictionaryPayload["k"] as? [String: Any] ?? [:]
        let chId = k["ch"] as? String ?? ""
        let from = k["from"] as? String ?? "Kanka"
        let title = k["title"] as? String ?? from
        let video = (k["video"] as? Bool) ?? ((k["video"] as? String) == "1")
        // Aynı sohbetten zaten çalan arama varsa yenisini açma ama Apple kuralı gereği yine bildir ve hemen kapat
        let uuid = UUID()
        let update = CXCallUpdate()
        update.remoteHandle = CXHandle(type: .generic, value: from)
        update.localizedCallerName = title
        update.hasVideo = video
        update.supportsHolding = false
        update.supportsGrouping = false
        update.supportsUngrouping = false
        update.supportsDTMF = false
        let duplicate = calls.values.contains { ($0["chId"] as? String) == chId }
        provider.reportNewIncomingCall(with: uuid, update: update) { [weak self] error in
            guard let self = self else { completion(); return }
            if error == nil {
                if duplicate || chId.isEmpty {
                    self.provider.reportCall(with: uuid, endedAt: Date(), reason: .remoteEnded)
                } else {
                    self.calls[uuid] = ["chId": chId, "from": from, "title": title, "video": video]
                    // Arayan vazgeçerse sunucu bunu iletemiyor; arama 35 saniye sonra kendiliğinden düşer (sunucudaki çalma süresi 32 sn)
                    self.timers[uuid] = Timer.scheduledTimer(withTimeInterval: 35, repeats: false) { [weak self] _ in
                        self?.finish(uuid, reason: .unanswered)
                    }
                }
            }
            completion()
        }
    }

    // MARK: CallKit
    func providerDidReset(_ provider: CXProvider) { calls.removeAll(); timers.values.forEach { $0.invalidate() }; timers.removeAll() }

    func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        timers[action.callUUID]?.invalidate(); timers[action.callUUID] = nil
        if var info = calls[action.callUUID] { info["action"] = "answer"; info["uuid"] = action.callUUID.uuidString; deliver(info) }
        action.fulfill()
    }

    func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        timers[action.callUUID]?.invalidate(); timers[action.callUUID] = nil
        if var info = calls.removeValue(forKey: action.callUUID) {
            // Cevaplanmadan kapatıldıysa reddetmiş sayılır; cevaplandıktan sonra kapatıldıysa aramadan çıkılır
            info["action"] = (info["answered"] as? Bool) == true ? "hangup" : "decline"
            info["uuid"] = action.callUUID.uuidString
            deliver(info)
        }
        action.fulfill()
    }

    func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
        plugin?.emit("callAction", ["action": action.isMuted ? "mute" : "unmute"])
        action.fulfill()
    }

    private func deliver(_ info: [String: Any]) {
        if info["action"] as? String == "answer", let s = info["uuid"] as? String, let u = UUID(uuidString: s) { calls[u]?["answered"] = true }
        if let p = plugin, p.ready { p.emit("callAction", info) } else { pending.append(info) }
    }

    func takePending() -> [[String: Any]] { let p = pending; pending = []; return p }

    private func finish(_ uuid: UUID, reason: CXCallEndedReason) {
        timers[uuid]?.invalidate(); timers[uuid] = nil
        guard calls.removeValue(forKey: uuid) != nil else { return }
        provider.reportCall(with: uuid, endedAt: Date(), reason: reason)
    }

    /// Arayüz aramadan çıkınca ya da arama başka yerde bitince (arayan vazgeçti, başka cihazdan cevaplandı) CallKit ekranını kapat
    func end(chId: String?) {
        for (uuid, info) in calls where chId == nil || (info["chId"] as? String) == chId {
            let reason: CXCallEndedReason = (info["answered"] as? Bool) == true ? .remoteEnded : .unanswered
            finish(uuid, reason: reason)
        }
    }
}

/// Web arayüzü köprüsü: window.Capacitor.Plugins.KankaCall
@objc(KankaCallPlugin)
public class KankaCallPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "KankaCallPlugin"
    public let jsName = "KankaCall"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "register", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pending", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "end", returnType: CAPPluginReturnPromise),
    ]
    private(set) var ready = false

    override public func load() { KankaCallManager.shared.plugin = self }

    func emit(_ event: String, _ data: [String: Any]) { DispatchQueue.main.async { self.notifyListeners(event, data: data, retainUntilConsumed: true) } }

    /// Arayüz giriş yaptıktan sonra çağırır: VoIP jetonunu döner, bekleyen eylemleri arayüze bırakır
    @objc func register(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            KankaCallManager.shared.start()
            self.ready = true
            call.resolve(["token": KankaCallManager.shared.voipToken ?? ""])
        }
    }

    @objc func pending(_ call: CAPPluginCall) {
        DispatchQueue.main.async { call.resolve(["actions": KankaCallManager.shared.takePending()]) }
    }

    @objc func end(_ call: CAPPluginCall) {
        let chId = call.getString("chId")
        DispatchQueue.main.async { KankaCallManager.shared.end(chId: chId); call.resolve() }
    }
}
