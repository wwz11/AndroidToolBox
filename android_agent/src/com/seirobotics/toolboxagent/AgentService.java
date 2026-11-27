package com.seirobotics.toolboxagent;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import org.json.JSONObject;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class AgentService extends Service {
    public static final String ACTION_BOOT_EVENT = "com.seirobotics.toolboxagent.INTERNAL_BOOT";
    public static final String ACTION_START_REBOOT = "com.seirobotics.toolboxagent.ACTION_START_REBOOT";
    public static final String ACTION_STOP = "com.seirobotics.toolboxagent.ACTION_STOP";
    public static final String ACTION_RESET = "com.seirobotics.toolboxagent.ACTION_RESET";
    public static final String ACTION_STATE_CHANGED = "com.seirobotics.toolboxagent.STATE_CHANGED";

    public static final int HTTP_PORT = 17839;
    private static final String CHANNEL_ID = "toolbox_agent_channel";
    private static final int NOTIF_ID = 1001;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final ExecutorService stateWorker = Executors.newSingleThreadExecutor();
    private final ExecutorService httpWorker = Executors.newCachedThreadPool();
    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;
    private ServerSocket httpServer;
    private volatile boolean serverRunning = false;
    private Runnable pendingRebootTask;

    @Override
    public void onCreate() {
        super.onCreate();
        startForegroundCompat("Toolbox Agent 运行中");
        acquireLocks();
        startHttpServer();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startForegroundCompat("Toolbox Agent 运行中");
        String action = intent == null ? "" : (intent.getAction() == null ? "" : intent.getAction());
        if (ACTION_START_REBOOT.equals(action)) {
            String mode = intent.getStringExtra("mode");
            if (mode == null || mode.isEmpty()) mode = "count";
            int targetCount = intent.getIntExtra("target_count", 10);
            double runHours = intent.getDoubleExtra("run_hours", 1.0);
            int stableSec = intent.getIntExtra("stable_sec", 30);
            startRebootTest(mode, targetCount, runHours, stableSec);
        } else if (ACTION_STOP.equals(action)) {
            stopStressTest("用户停止");
        } else if (ACTION_RESET.equals(action)) {
            resetState();
        } else if (ACTION_BOOT_EVENT.equals(action)) {
            stateWorker.execute(this::handleBootEvent);
        } else {
            stateWorker.execute(this::refreshCapabilities);
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        serverRunning = false;
        try {
            if (httpServer != null) httpServer.close();
        } catch (Exception ignored) {}
        cancelPendingReboot();
        releaseLocks();
        stateWorker.shutdownNow();
        httpWorker.shutdownNow();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void startForegroundCompat(String text) {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null && Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL_ID, "Toolbox Agent", NotificationManager.IMPORTANCE_LOW);
            nm.createNotificationChannel(ch);
        }
        Notification.Builder nb = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);
        nb.setContentTitle("AndroidTVToolBox Agent")
                .setContentText(text)
                .setSmallIcon(android.R.drawable.stat_notify_sync)
                .setOngoing(true);
        startForeground(NOTIF_ID, nb.build());
    }

    private void acquireLocks() {
        try {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm != null && (wakeLock == null || !wakeLock.isHeld())) {
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "ToolboxAgent:KeepAlive");
                wakeLock.acquire();
            }
        } catch (Exception ignored) {}
        try {
            WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wm != null && (wifiLock == null || !wifiLock.isHeld())) {
                wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "ToolboxAgent:WifiKeepAlive");
                wifiLock.acquire();
            }
        } catch (Exception ignored) {}
    }

    private void releaseLocks() {
        try {
            if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        } catch (Exception ignored) {}
        try {
            if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        } catch (Exception ignored) {}
    }

    private void cancelPendingReboot() {
        if (pendingRebootTask != null) {
            mainHandler.removeCallbacks(pendingRebootTask);
            pendingRebootTask = null;
        }
    }

    private void refreshCapabilities() {
        JSONObject st = AgentStore.loadState(this);
        try {
            st.put("can_self_reboot", DeviceProbe.canSelfReboot(this));
            st.put("ip", DeviceProbe.getLocalIpv4());
            st.put("adb_tcp_port", DeviceProbe.getProp("service.adb.tcp.port"));
            AgentStore.saveState(this, st);
        } catch (Exception ignored) {}
        broadcastStateChanged();
    }

    public void startRebootTest(String mode, int targetCount, double runHours, int stableSec) {
        cancelPendingReboot();
        stateWorker.execute(() -> {
            boolean canReboot = DeviceProbe.canSelfReboot(this);
            JSONObject st = AgentStore.defaultState();
            try {
                st.put("state", AgentStore.STATE_RUNNING);
                st.put("mode", "hours".equalsIgnoreCase(mode) ? "hours" : "count");
                st.put("target_count", Math.max(1, targetCount));
                st.put("run_hours", Math.max(0.05, runHours));
                st.put("stable_sec", Math.max(5, stableSec));
                st.put("start_epoch_ms", System.currentTimeMillis());
                st.put("accumulated_ms", 0L);
                st.put("boot_uptime_ms", SystemClock.elapsedRealtime());
                st.put("last_boot_id", DeviceProbe.getBootId());
                st.put("last_boot_reason", DeviceProbe.getBootReason());
                st.put("can_self_reboot", canReboot);
                st.put("waiting_pc_reboot", false);
                st.put("ip", DeviceProbe.getLocalIpv4());
                st.put("adb_tcp_port", DeviceProbe.getProp("service.adb.tcp.port"));
                AgentStore.saveState(this, st);
                AgentStore.appendLog(this, "开始设备端 Reboot 压测: mode=" + st.optString("mode")
                        + ", target=" + st.optInt("target_count")
                        + ", hours=" + st.optDouble("run_hours")
                        + ", self_reboot=" + canReboot);
            } catch (Exception ignored) {}
            broadcastStateChanged();
            scheduleNextReboot(3);
        });
    }

    public void stopStressTest(String reason) {
        cancelPendingReboot();
        AgentStore.clearRebootReq(this);
        JSONObject st = AgentStore.loadState(this);
        try {
            st.put("state", AgentStore.STATE_STOPPED);
            st.put("waiting_pc_reboot", false);
            st.put("next_reboot_uptime_ms", 0L);
            st.put("stop_reason", reason);
            AgentStore.saveState(this, st);
            AgentStore.appendLog(this, "停止压测: " + reason);
        } catch (Exception ignored) {}
        broadcastStateChanged();
    }

    public void resetState() {
        cancelPendingReboot();
        AgentStore.clearRebootReq(this);
        JSONObject st = AgentStore.defaultState();
        try {
            st.put("can_self_reboot", DeviceProbe.canSelfReboot(this));
            st.put("ip", DeviceProbe.getLocalIpv4());
            st.put("adb_tcp_port", DeviceProbe.getProp("service.adb.tcp.port"));
            AgentStore.saveState(this, st);
            AgentStore.appendLog(this, "已重置压测记录");
        } catch (Exception ignored) {}
        broadcastStateChanged();
    }

    private void handleBootEvent() {
        AgentStore.clearRebootReq(this);
        JSONObject st = AgentStore.loadState(this);
        String bootId = DeviceProbe.getBootId();
        boolean canReboot = DeviceProbe.canSelfReboot(this);
        try {
            st.put("can_self_reboot", canReboot);
            st.put("ip", DeviceProbe.getLocalIpv4());
            st.put("adb_tcp_port", DeviceProbe.getProp("service.adb.tcp.port"));

            if (!AgentStore.STATE_RUNNING.equals(st.optString("state"))) {
                AgentStore.saveState(this, st);
                broadcastStateChanged();
                return;
            }
            launchMainUi();
            if (bootId.equals(st.optString("last_boot_id"))) {
                AgentStore.saveState(this, st);
                broadcastStateChanged();
                if (pendingRebootTask == null && !st.optBoolean("waiting_pc_reboot", false)) {
                    int stableSec = Math.max(5, st.optInt("stable_sec", 30));
                    AgentStore.appendLog(this, "服务被重新拉起，恢复下一次重启调度...");
                    scheduleNextReboot(stableSec);
                }
                return;
            }

            st.put("last_boot_id", bootId);
            st.put("waiting_pc_reboot", false);
            int round = st.optInt("current_round", 0) + 1;
            st.put("current_round", round);

            String reason = DeviceProbe.getBootReason();
            String anomaly = DeviceProbe.checkBootAnomaly(reason);
            st.put("last_boot_reason", reason);
            st.put("last_anomaly_detail", anomaly);

            if (!anomaly.isEmpty()) {
                st.put("fail_rounds", st.optInt("fail_rounds", 0) + 1);
                st.put("anomaly_count", st.optInt("anomaly_count", 0) + 1);
                st.put("state", AgentStore.STATE_FAILED);
                st.put("stop_reason", "第 " + round + " 次开机检测到异常: " + anomaly);
                AgentStore.saveState(this, st);
                AgentStore.appendLog(this, "ERROR 第 " + round + " 次开机异常 (" + anomaly + "), reason=" + reason);
                broadcastStateChanged();
                return;
            }

            st.put("success_rounds", st.optInt("success_rounds", 0) + 1);
            AgentStore.appendLog(this, "第 " + round + " 次开机正常, reason=" + (reason.isEmpty() ? "-" : reason));

            String mode = st.optString("mode", "count");
            if ("hours".equals(mode)) {
                long accMs = st.optLong("accumulated_ms", 0L) + SystemClock.elapsedRealtime();
                st.put("boot_uptime_ms", SystemClock.elapsedRealtime());
                // 断线兜底时按 1.05 倍目标时长触发，避免 APK 抢跑早于 PC 单调时钟而触发时长不足误判
                double targetMs = st.optDouble("run_hours", 1.0) * 3600_000.0 * 1.05;
                if (accMs >= targetMs) {
                    st.put("accumulated_ms", accMs);
                    st.put("state", AgentStore.STATE_COMPLETED);
                    st.put("stop_reason", "已达到目标压测时长");
                    AgentStore.saveState(this, st);
                    AgentStore.appendLog(this, "压测完成: 已达到目标时长");
                    broadcastStateChanged();
                    return;
                }
            } else {
                int target = st.optInt("target_count", 10);
                if (round >= target) {
                    st.put("state", AgentStore.STATE_COMPLETED);
                    st.put("stop_reason", "已完成全部 " + target + " 次重启");
                    AgentStore.saveState(this, st);
                    AgentStore.appendLog(this, "压测完成: 共 " + target + " 次");
                    broadcastStateChanged();
                    return;
                }
            }

            AgentStore.saveState(this, st);
            broadcastStateChanged();
            int stableSec = Math.max(5, st.optInt("stable_sec", 30));
            scheduleNextReboot(stableSec);
        } catch (Exception ignored) {}
    }

    private void scheduleNextReboot(int delaySec) {
        cancelPendingReboot();
        try {
            JSONObject cur = AgentStore.loadState(this);
            cur.put("next_reboot_uptime_ms", SystemClock.elapsedRealtime() + delaySec * 1000L);
            AgentStore.saveState(this, cur);
            broadcastStateChanged();
        } catch (Exception ignored) {}
        pendingRebootTask = () -> stateWorker.execute(() -> {
            JSONObject st = AgentStore.loadState(this);
            if (!AgentStore.STATE_RUNNING.equals(st.optString("state"))) return;
            try {
                long prevUptime = st.optLong("boot_uptime_ms", 0L);
                long curUptime = SystemClock.elapsedRealtime();
                long delta = prevUptime > 0 && curUptime >= prevUptime ? (curUptime - prevUptime) : curUptime;
                // 仅累加实际运行耗时，不虚增固定重启耗时，避免受 RTC/NTP 校时跳变影响
                st.put("accumulated_ms", st.optLong("accumulated_ms", 0L) + delta);
                st.put("boot_uptime_ms", 0L);
                st.put("next_reboot_uptime_ms", 0L);
                AgentStore.saveState(this, st);
            } catch (Exception ignored) {}
            AgentStore.appendLog(this, "由 APK 发起第 " + (st.optInt("current_round", 0) + 1) + " 次重启...");
            AgentStore.writeRebootReq(this, st.optInt("current_round", 0) + 1);
            boolean sent = DeviceProbe.triggerReboot(this);
            if (!sent) {
                try {
                    st.put("waiting_pc_reboot", true);
                    AgentStore.saveState(this, st);
                    AgentStore.appendLog(this, "已写入 reboot.req，等待设备守护/ADB 执行重启");
                } catch (Exception ignored) {}
                broadcastStateChanged();
            }
        });
        mainHandler.postDelayed(pendingRebootTask, delaySec * 1000L);
    }

    private void launchMainUi() {
        try {
            Intent ui = new Intent(this, MainActivity.class);
            ui.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                    | Intent.FLAG_ACTIVITY_SINGLE_TOP
                    | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            startActivity(ui);
        } catch (Exception ignored) {}
    }

    private void broadcastStateChanged() {
        try {
            Intent i = new Intent(ACTION_STATE_CHANGED);
            i.setPackage(getPackageName());
            sendBroadcast(i);
        } catch (Exception ignored) {}
    }

    private void startHttpServer() {
        serverRunning = true;
        httpWorker.execute(() -> {
            try {
                httpServer = new ServerSocket(HTTP_PORT, 16, InetAddress.getByName("127.0.0.1"));
                while (serverRunning && !httpServer.isClosed()) {
                    Socket sock = httpServer.accept();
                    httpWorker.execute(() -> handleHttpClient(sock));
                }
            } catch (Exception e) {
                AgentStore.appendLog(this, "本地状态服务监听失败: " + e.getMessage());
            }
        });
    }

    private void handleHttpClient(Socket sock) {
        try (Socket s = sock;
             BufferedReader in = new BufferedReader(
                     new InputStreamReader(s.getInputStream(), StandardCharsets.UTF_8));
             OutputStream out = s.getOutputStream()) {
            String reqLine = in.readLine();
            if (reqLine == null) return;
            String[] parts = reqLine.split(" ");
            String method = parts.length > 0 ? parts[0] : "GET";
            String path = parts.length > 1 ? parts[1] : "/";
            int contentLen = 0;
            String line;
            while ((line = in.readLine()) != null && !line.isEmpty()) {
                if (line.toLowerCase().startsWith("content-length:")) {
                    try {
                        contentLen = Integer.parseInt(line.substring(15).trim());
                    } catch (Exception ignored) {}
                }
            }
            String body = "";
            if (contentLen > 0 && contentLen < 65536) {
                char[] buf = new char[contentLen];
                int read = 0;
                while (read < contentLen) {
                    int n = in.read(buf, read, contentLen - read);
                    if (n < 0) break;
                    read += n;
                }
                body = new String(buf, 0, read);
            }

            String respBody;
            if ("GET".equals(method) && path.startsWith("/logs")) {
                JSONObject r = new JSONObject();
                r.put("logs", AgentStore.readTailLog(this, 100));
                respBody = r.toString();
            } else if ("POST".equals(method) && path.startsWith("/start")) {
                JSONObject req = body.isEmpty() ? new JSONObject() : new JSONObject(body);
                startRebootTest(
                        req.optString("mode", "count"),
                        req.optInt("target_count", 10),
                        req.optDouble("run_hours", 1.0),
                        req.optInt("stable_sec", 30));
                respBody = "{\"ok\":true}";
            } else if ("POST".equals(method) && path.startsWith("/stop")) {
                stopStressTest("PC端请求停止");
                respBody = "{\"ok\":true}";
            } else if ("POST".equals(method) && path.startsWith("/reset")) {
                resetState();
                respBody = "{\"ok\":true}";
            } else {
                JSONObject st = AgentStore.loadState(this);
                st.put("ip", DeviceProbe.getLocalIpv4());
                st.put("adb_tcp_port", DeviceProbe.getProp("service.adb.tcp.port"));
                respBody = st.toString();
            }

            byte[] bytes = respBody.getBytes(StandardCharsets.UTF_8);
            String hdr = "HTTP/1.1 200 OK\r\n"
                    + "Content-Type: application/json; charset=utf-8\r\n"
                    + "Content-Length: " + bytes.length + "\r\n"
                    + "Connection: close\r\n\r\n";
            out.write(hdr.getBytes(StandardCharsets.US_ASCII));
            out.write(bytes);
            out.flush();
        } catch (Exception ignored) {}
    }
}
