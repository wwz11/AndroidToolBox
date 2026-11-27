package com.seirobotics.toolboxagent;

import android.content.Context;
import org.json.JSONObject;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

public final class AgentStore {
    public static final String STATE_IDLE = "IDLE";
    public static final String STATE_RUNNING = "RUNNING";
    public static final String STATE_COMPLETED = "COMPLETED";
    public static final String STATE_FAILED = "FAILED";
    public static final String STATE_STOPPED = "STOPPED";

    private static final Object LOCK = new Object();

    private AgentStore() {}

    public static File getBaseDir(Context ctx) {
        File ext = ctx.getExternalFilesDir(null);
        if (ext != null) {
            if (!ext.exists()) ext.mkdirs();
            return ext;
        }
        File internal = ctx.getFilesDir();
        if (!internal.exists()) internal.mkdirs();
        return internal;
    }

    public static File getStateFile(Context ctx) {
        return new File(getBaseDir(ctx), "state.json");
    }

    public static File getLogFile(Context ctx) {
        return new File(getBaseDir(ctx), "agent.log");
    }

    public static File getRebootReqFile(Context ctx) {
        return new File(getBaseDir(ctx), "reboot.req");
    }

    public static void writeRebootReq(Context ctx, int round) {
        try {
            File f = getRebootReqFile(ctx);
            try (FileOutputStream fos = new FileOutputStream(f, false)) {
                fos.write((round + "\n").getBytes(StandardCharsets.UTF_8));
                fos.getFD().sync();
            }
        } catch (Exception ignored) {}
    }

    public static void clearRebootReq(Context ctx) {
        try {
            File f = getRebootReqFile(ctx);
            if (f.exists()) f.delete();
        } catch (Exception ignored) {}
    }

    public static JSONObject defaultState() {
        JSONObject o = new JSONObject();
        try {
            o.put("state", STATE_IDLE);
            o.put("mode", "count");
            o.put("target_count", 10);
            o.put("run_hours", 1.0);
            o.put("stable_sec", 30);
            o.put("start_epoch_ms", 0L);
            o.put("accumulated_ms", 0L);
            o.put("boot_uptime_ms", 0L);
            o.put("current_round", 0);
            o.put("success_rounds", 0);
            o.put("fail_rounds", 0);
            o.put("anomaly_count", 0);
            o.put("last_boot_id", "");
            o.put("last_boot_reason", "");
            o.put("last_anomaly_detail", "");
            o.put("waiting_pc_reboot", false);
            o.put("can_self_reboot", false);
            o.put("stop_reason", "");
            o.put("updated_at", nowStr());
        } catch (Exception ignored) {}
        return o;
    }

    public static JSONObject loadState(Context ctx) {
        synchronized (LOCK) {
            File f = getStateFile(ctx);
            if (!f.exists()) return defaultState();
            try (FileInputStream fis = new FileInputStream(f);
                 InputStreamReader isr = new InputStreamReader(fis, StandardCharsets.UTF_8);
                 BufferedReader br = new BufferedReader(isr)) {
                StringBuilder sb = new StringBuilder();
                String line;
                while ((line = br.readLine()) != null) sb.append(line);
                JSONObject obj = new JSONObject(sb.toString());
                JSONObject def = defaultState();
                java.util.Iterator<String> keys = def.keys();
                while (keys.hasNext()) {
                    String k = keys.next();
                    if (!obj.has(k)) obj.put(k, def.get(k));
                }
                return obj;
            } catch (Exception e) {
                return defaultState();
            }
        }
    }

    public static void saveState(Context ctx, JSONObject state) {
        synchronized (LOCK) {
            try {
                state.put("updated_at", nowStr());
                File target = getStateFile(ctx);
                File tmp = new File(target.getParentFile(), "state.json.tmp");
                try (FileOutputStream fos = new FileOutputStream(tmp, false)) {
                    fos.write(state.toString(2).getBytes(StandardCharsets.UTF_8));
                    fos.getFD().sync();
                }
                if (target.exists()) target.delete();
                tmp.renameTo(target);
            } catch (Exception ignored) {}
        }
    }

    public static void appendLog(Context ctx, String msg) {
        synchronized (LOCK) {
            try {
                File f = getLogFile(ctx);
                if (f.exists() && f.length() > 512 * 1024) {
                    File bak = new File(f.getParentFile(), "agent.log.1");
                    if (bak.exists()) bak.delete();
                    f.renameTo(bak);
                }
                String line = nowStr() + "  " + msg + "\n";
                try (FileOutputStream fos = new FileOutputStream(f, true)) {
                    fos.write(line.getBytes(StandardCharsets.UTF_8));
                }
            } catch (Exception ignored) {}
        }
    }

    public static String readTailLog(Context ctx, int maxLines) {
        synchronized (LOCK) {
            File f = getLogFile(ctx);
            if (!f.exists()) return "";
            java.util.LinkedList<String> lines = new java.util.LinkedList<>();
            try (BufferedReader br = new BufferedReader(
                    new InputStreamReader(new FileInputStream(f), StandardCharsets.UTF_8))) {
                String ln;
                while ((ln = br.readLine()) != null) {
                    lines.add(ln);
                    if (lines.size() > maxLines) lines.removeFirst();
                }
            } catch (Exception ignored) {}
            StringBuilder sb = new StringBuilder();
            for (String s : lines) sb.append(s).append('\n');
            return sb.toString();
        }
    }

    public static String nowStr() {
        return new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).format(new Date());
    }
}
