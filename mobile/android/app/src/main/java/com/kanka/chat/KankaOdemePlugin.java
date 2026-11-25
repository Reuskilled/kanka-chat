package com.kanka.chat;

import com.android.billingclient.api.AcknowledgePurchaseParams;
import com.android.billingclient.api.BillingClient;
import com.android.billingclient.api.BillingClientStateListener;
import com.android.billingclient.api.BillingFlowParams;
import com.android.billingclient.api.BillingResult;
import com.android.billingclient.api.PendingPurchasesParams;
import com.android.billingclient.api.ProductDetails;
import com.android.billingclient.api.Purchase;
import com.android.billingclient.api.PurchasesUpdatedListener;
import com.android.billingclient.api.QueryProductDetailsParams;
import com.android.billingclient.api.QueryPurchasesParams;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Google Play Faturalandırma köprüsü (Kanka Spark aboneliği).
 * Satın alma Google Play'in kendi ekranında olur; sonuç (purchaseToken) sunucuya gönderilir,
 * sunucu Google Play Developer API ile doğrular, Spark'ı açar ve satın almayı onaylar (acknowledge).
 *
 *  urunler({ ids: [...] })                 : abonelik ürünleri { urunler: [{ id, ad, aciklama, teklifler: [{ token, plan, teklif, fazlar: [{ fiyat, mikro, para, donem, tekrar }] }] }] }
 *  satinAl({ urun, teklif, hesap })         : Google Play satın alma ekranını açar. Sonuç 'satinAlim' olayıyla gelir
 *  mevcutlar()                              : bu Google hesabındaki aktif abonelikler { satinAlimlar: [...] } (geri yükleme)
 *  olay 'satinAlim' { durum, satinAlimlar } : durum = tamam | iptal | zaten | hata
 */
@CapacitorPlugin(name = "KankaOdeme")
public class KankaOdemePlugin extends Plugin {
    private BillingClient client;
    private final Map<String, ProductDetails> cache = new HashMap<>();
    private final List<Runnable> waiting = new ArrayList<>();
    private boolean connecting = false;

    private final PurchasesUpdatedListener updates = (BillingResult r, List<Purchase> list) -> {
        JSObject o = new JSObject();
        int code = r.getResponseCode();
        o.put("durum", code == BillingClient.BillingResponseCode.OK ? "tamam"
            : code == BillingClient.BillingResponseCode.USER_CANCELED ? "iptal"
            : code == BillingClient.BillingResponseCode.ITEM_ALREADY_OWNED ? "zaten" : "hata");
        o.put("kod", code);
        o.put("mesaj", r.getDebugMessage());
        o.put("satinAlimlar", purchasesJson(list));
        notifyListeners("satinAlim", o, true);
    };

    @Override
    public void load() {
        client = BillingClient.newBuilder(getContext())
            .setListener(updates)
            .enablePendingPurchases(PendingPurchasesParams.newBuilder().enableOneTimeProducts().build())
            .enableAutoServiceReconnection()
            .build();
    }

    private void ready(Runnable ok, PluginCall call) {
        if (client.isReady()) { ok.run(); return; }
        synchronized (waiting) {
            waiting.add(ok);
            if (connecting) return;
            connecting = true;
        }
        client.startConnection(new BillingClientStateListener() {
            @Override public void onBillingSetupFinished(BillingResult r) {
                List<Runnable> run;
                synchronized (waiting) { connecting = false; run = new ArrayList<>(waiting); waiting.clear(); }
                if (r.getResponseCode() == BillingClient.BillingResponseCode.OK) { for (Runnable x : run) x.run(); }
                else if (call != null) call.reject("Google Play faturalandırma kullanılamıyor: " + r.getDebugMessage(), String.valueOf(r.getResponseCode()));
            }
            @Override public void onBillingServiceDisconnected() { synchronized (waiting) { connecting = false; } }
        });
    }

    private static JSArray purchasesJson(List<Purchase> list) {
        JSArray a = new JSArray();
        if (list == null) return a;
        for (Purchase p : list) {
            JSObject x = new JSObject();
            x.put("token", p.getPurchaseToken());
            JSArray ids = new JSArray(); for (String id : p.getProducts()) ids.put(id);
            x.put("urunler", ids);
            x.put("durum", p.getPurchaseState() == Purchase.PurchaseState.PURCHASED ? "alindi" : p.getPurchaseState() == Purchase.PurchaseState.PENDING ? "bekliyor" : "bilinmiyor");
            x.put("onayli", p.isAcknowledged());
            x.put("yenileniyor", p.isAutoRenewing());
            x.put("siparis", p.getOrderId());
            a.put(x);
        }
        return a;
    }

    @PluginMethod
    public void urunler(PluginCall call) {
        JSArray ids = call.getArray("ids");
        List<QueryProductDetailsParams.Product> ps = new ArrayList<>();
        try { for (int i = 0; i < ids.length(); i++) ps.add(QueryProductDetailsParams.Product.newBuilder().setProductId(ids.getString(i)).setProductType(BillingClient.ProductType.SUBS).build()); }
        catch (Exception e) { call.reject("ids gerekli"); return; }
        if (ps.isEmpty()) { call.reject("ids gerekli"); return; }
        ready(() -> client.queryProductDetailsAsync(QueryProductDetailsParams.newBuilder().setProductList(ps).build(), (r, res) -> {
            if (r.getResponseCode() != BillingClient.BillingResponseCode.OK) { call.reject("Ürünler alınamadı: " + r.getDebugMessage(), String.valueOf(r.getResponseCode())); return; }
            JSArray out = new JSArray();
            for (ProductDetails d : res.getProductDetailsList()) {
                cache.put(d.getProductId(), d);
                JSObject u = new JSObject();
                u.put("id", d.getProductId()); u.put("ad", d.getName()); u.put("aciklama", d.getDescription());
                JSArray offers = new JSArray();
                List<ProductDetails.SubscriptionOfferDetails> od = d.getSubscriptionOfferDetails();
                if (od != null) for (ProductDetails.SubscriptionOfferDetails o : od) {
                    JSObject t = new JSObject();
                    t.put("token", o.getOfferToken()); t.put("plan", o.getBasePlanId()); t.put("teklif", o.getOfferId());
                    JSArray phases = new JSArray();
                    for (ProductDetails.PricingPhase ph : o.getPricingPhases().getPricingPhaseList()) {
                        JSObject f = new JSObject();
                        f.put("fiyat", ph.getFormattedPrice()); f.put("mikro", ph.getPriceAmountMicros()); f.put("para", ph.getPriceCurrencyCode());
                        f.put("donem", ph.getBillingPeriod()); f.put("tekrar", ph.getRecurrenceMode()); f.put("sayi", ph.getBillingCycleCount());
                        phases.put(f);
                    }
                    t.put("fazlar", phases);
                    offers.put(t);
                }
                u.put("teklifler", offers);
                out.put(u);
            }
            JSObject ret = new JSObject(); ret.put("urunler", out); call.resolve(ret);
        }), call);
    }

    @PluginMethod
    public void satinAl(PluginCall call) {
        String urun = call.getString("urun"), teklif = call.getString("teklif"), hesap = call.getString("hesap");
        ProductDetails d = urun == null ? null : cache.get(urun);
        if (d == null || teklif == null) { call.reject("Önce urunler() çağrılmalı"); return; }
        ready(() -> getActivity().runOnUiThread(() -> {
            BillingFlowParams.Builder b = BillingFlowParams.newBuilder().setProductDetailsParamsList(java.util.Collections.singletonList(
                BillingFlowParams.ProductDetailsParams.newBuilder().setProductDetails(d).setOfferToken(teklif).build()));
            if (hesap != null && !hesap.isEmpty()) b.setObfuscatedAccountId(hesap); // satın almayı Kanka hesabına bağlar (sunucu doğrular)
            BillingResult r = client.launchBillingFlow(getActivity(), b.build());
            if (r.getResponseCode() == BillingClient.BillingResponseCode.OK) { JSObject o = new JSObject(); o.put("baslatildi", true); call.resolve(o); }
            else call.reject("Satın alma açılamadı: " + r.getDebugMessage(), String.valueOf(r.getResponseCode()));
        }), call);
    }

    @PluginMethod
    public void mevcutlar(PluginCall call) {
        ready(() -> client.queryPurchasesAsync(QueryPurchasesParams.newBuilder().setProductType(BillingClient.ProductType.SUBS).build(), (r, list) -> {
            if (r.getResponseCode() != BillingClient.BillingResponseCode.OK) { call.reject("Abonelikler alınamadı: " + r.getDebugMessage(), String.valueOf(r.getResponseCode())); return; }
            JSObject o = new JSObject(); o.put("satinAlimlar", purchasesJson(list)); call.resolve(o);
        }), call);
    }

    /** Yedek: sunucu onaylayamazsa (ör. Play API ayarlı değil) uygulama tarafında onay. Normalde sunucu onaylar. */
    @PluginMethod
    public void onayla(PluginCall call) {
        String token = call.getString("token");
        if (token == null) { call.reject("token gerekli"); return; }
        ready(() -> client.acknowledgePurchase(AcknowledgePurchaseParams.newBuilder().setPurchaseToken(token).build(), r -> {
            if (r.getResponseCode() == BillingClient.BillingResponseCode.OK) call.resolve(); else call.reject(r.getDebugMessage(), String.valueOf(r.getResponseCode()));
        }), call);
    }
}
