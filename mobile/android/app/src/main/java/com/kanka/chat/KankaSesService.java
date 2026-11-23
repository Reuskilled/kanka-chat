package com.kanka.chat;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;

/** Sesli odadayken çalışan ön plan hizmeti: Android, arka plandaki uygulamaların mikrofonunu ancak böyle bir hizmet varsa açık tutar. */
public class KankaSesService extends Service {
    static final String CHANNEL = "ses";
    static final String ACTION_LEAVE = "com.kanka.chat.SES_AYRIL";
    static final String ACTION_LEAVE_TO_APP = "com.kanka.chat.SES_AYRIL_UYGULAMA";

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_LEAVE.equals(intent.getAction())) {
            sendBroadcast(new Intent(ACTION_LEAVE_TO_APP).setPackage(getPackageName()));
            stopSelf();
            return START_NOT_STICKY;
        }
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Sesli bağlantı", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Sesli odadayken gösterilir");
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
        int pf = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
        Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent openPi = PendingIntent.getActivity(this, 0, open, pf);
        PendingIntent leavePi = PendingIntent.getService(this, 1, new Intent(this, KankaSesService.class).setAction(ACTION_LEAVE), pf);
        String title = intent != null ? intent.getStringExtra("baslik") : null;
        String text = intent != null ? intent.getStringExtra("metin") : null;
        Notification n = new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_kanka)
            .setColor(0xFFD4FF00)
            .setContentTitle(title != null ? title : "Sesli odadasın")
            .setContentText(text != null ? text : "Kanka Chat · dokun, uygulamaya dön")
            .setContentIntent(openPi)
            .addAction(0, "Ayrıl", leavePi)
            .setOngoing(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build();
        int type = Build.VERSION.SDK_INT >= 30 ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE : 0;
        try { ServiceCompat.startForeground(this, 41, n, type); }
        catch (Exception e) { stopSelf(); } // mikrofon izni yoksa Android 14 hizmeti başlatmaz: uygulama çökmesin
        return START_NOT_STICKY;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) { stopSelf(); } // uygulama kaydırılıp kapatılınca sesten de çık

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
