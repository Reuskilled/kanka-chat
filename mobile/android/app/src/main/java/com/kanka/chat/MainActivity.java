package com.kanka.chat;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(KankaSesPlugin.class); // sesli oda: ön plan hizmeti ve ses çıkışı seçimi
        registerPlugin(KankaOdemePlugin.class); // Google Play Faturalandırma: Kanka Spark aboneliği
        super.onCreate(savedInstanceState);
    }
}
