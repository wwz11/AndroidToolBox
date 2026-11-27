package com.seirobotics.toolboxagent;

import android.content.Context;
import android.os.PowerManager;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStreamReader;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.nio.charset.StandardCharsets;
import java.util.Enumeration;
import java.util.Locale;

public final class DeviceProbe {
    private static final String[] ANOMALY_TOKENS = {
        "kernel_panic", "panic", "watchdog", "hw_watchdog", "sw_watchdog",
        "under_voltage", "undervoltage", "uvlo", "brownout", "thermal",
        "overheat", "crash", "fatal", "ocpm", "rescueparty", "rescue_party",
        "hang", "oops", "bug"
    };

    private static final String[] PSTORE_PATHS = {
        "/sys/fs/pstore/console-ramoops-0",
        "/sys/fs/pstore/console-ramoops",
        "/proc/last_kmsg"
    };

    private DeviceProbe() {}

    public static String getProp(String key) {
        try {
            Process p = new ProcessBuilder("getprop", key).redirectErrorStream(true).start();
            try (BufferedReader br = new BufferedReader(
                    new InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8))) {
                String line = br.readLine();
                p.waitFor();
                return line == null ? "" : line.trim();
            }
        } catch (Exception e) {
            return "";
        }
    }

    public static String getBootId() {
        try (BufferedReader br = new BufferedReader(
                new InputStreamReader(new FileInputStream("/proc/sys/kernel/random/boot_id"), StandardCharsets.UTF_8))) {
            String ln = br.readLine();
            return ln == null ? "" : ln.trim();
        } catch (Exception e) {
            return String.valueOf(android.os.SystemClock.elapsedRealtime());
        }
    }

    public static String getBootReason() {
        String r = getProp("sys.boot.reason");
        if (!r.isEmpty()) return r;
        r = getProp("ro.boot.bootreason");
        if (!r.isEmpty()) return r;
        return getProp("persist.sys.boot.reason");
    }

    public static String scanPstoreAnomaly() {
        for (String path : PSTORE_PATHS) {
            File f = new File(path);
            if (!f.exists() || !f.canRead()) continue;
            try (BufferedReader br = new BufferedReader(
                    new InputStreamReader(new FileInputStream(f), StandardCharsets.UTF_8))) {
                StringBuilder tail = new StringBuilder();
                String ln;
                while ((ln = br.readLine()) != null) {
                    tail.append(ln.toLowerCase(Locale.US)).append('\n');
                    if (tail.length() > 16384) tail.delete(0, tail.length() - 8192);
                }
                String text = tail.toString();
                for (String tok : new String[]{"kernel panic", "watchdog", "oops:", "fatal exception", "bug:"}) {
                    if (text.contains(tok)) return tok.replace(":", "").trim();
                }
            } catch (Exception ignored) {}
        }
        return "";
    }

    public static String checkBootAnomaly(String reason) {
        String low = (reason == null ? "" : reason).toLowerCase(Locale.US);
        for (String tok : ANOMALY_TOKENS) {
            if (low.contains(tok)) return "boot_reason:" + tok;
        }
        String pstore = scanPstoreAnomaly();
        if (!pstore.isEmpty()) return "pstore:" + pstore;
        return "";
    }

    public static String getLocalIpv4() {
        try {
            Enumeration<NetworkInterface> ifaces = NetworkInterface.getNetworkInterfaces();
            while (ifaces.hasMoreElements()) {
                NetworkInterface nif = ifaces.nextElement();
                if (!nif.isUp() || nif.isLoopback()) continue;
                Enumeration<InetAddress> addrs = nif.getInetAddresses();
                while (addrs.hasMoreElements()) {
                    InetAddress addr = addrs.nextElement();
                    if (addr instanceof Inet4Address && !addr.isLoopbackAddress()) {
                        return addr.getHostAddress();
                    }
                }
            }
        } catch (Exception ignored) {}
        return "";
    }

    public static boolean runSuCommand(String cmd) {
        for (String[] argv : new String[][]{
                {"su", "0", "sh", "-c", cmd},
                {"su", "-c", cmd}
        }) {
            try {
                Process p = new ProcessBuilder(argv).redirectErrorStream(true).start();
                int rc = p.waitFor();
                if (rc == 0) return true;
            } catch (Exception ignored) {}
        }
        return false;
    }

    public static boolean runShellCommand(String cmd) {
        try {
            Process p = new ProcessBuilder("sh", "-c", cmd).redirectErrorStream(true).start();
            int rc = p.waitFor();
            return rc == 0;
        } catch (Exception ignored) {
            return false;
        }
    }

    public static boolean canSelfReboot(Context ctx) {
        if (runSuCommand("id")) return true;
        if (LocalAdbClient.isAvailable(5555)) return true;
        try {
            int granted = ctx.checkSelfPermission("android.permission.REBOOT");
            if (granted == android.content.pm.PackageManager.PERMISSION_GRANTED) return true;
        } catch (Exception ignored) {}
        return false;
    }

    public static boolean enableTcpAdb(int port) {
        String cur = getProp("service.adb.tcp.port");
        if (String.valueOf(port).equals(cur)) return true;
        return runSuCommand("setprop service.adb.tcp.port " + port + " && stop adbd && start adbd");
    }

    public static boolean triggerReboot(Context ctx) {
        if (runSuCommand("svc power reboot || reboot")) return true;
        if (LocalAdbClient.isAvailable(5555)) {
            LocalAdbClient.runShell(5555, "svc power reboot || reboot", 3000);
            return true;
        }
        if (runShellCommand("svc power reboot || reboot || setprop sys.powerctl reboot")) return true;
        try {
            PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
            if (pm != null) {
                pm.reboot("toolbox_stress");
                return true;
            }
        } catch (Exception ignored) {}
        return false;
    }
}
