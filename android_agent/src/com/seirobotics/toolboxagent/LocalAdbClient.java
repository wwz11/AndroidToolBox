package com.seirobotics.toolboxagent;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;

/**
 * 极简本机 ADB TCP 客户端（连接 127.0.0.1:5555）。
 * 在不修改 /system 分区、不依赖 PC 连接的情况下，通过本机 adbd (shell 权限) 执行 reboot 等命令。
 */
public final class LocalAdbClient {
    private static final int A_CNXN = 0x4e584e43;
    private static final int A_AUTH = 0x48545541;
    private static final int A_OPEN = 0x4e45504f;
    private static final int A_OKAY = 0x59414b4f;
    private static final int A_CLSE = 0x45534c43;
    private static final int A_WRTE = 0x45545257;

    private LocalAdbClient() {}

    private static void sendPacket(OutputStream out, int cmd, int arg0, int arg1, byte[] data) throws Exception {
        byte[] payload = data == null ? new byte[0] : data;
        int crc = 0;
        for (byte b : payload) {
            crc += (b & 0xFF);
        }
        ByteBuffer hdr = ByteBuffer.allocate(24).order(ByteOrder.LITTLE_ENDIAN);
        hdr.putInt(cmd);
        hdr.putInt(arg0);
        hdr.putInt(arg1);
        hdr.putInt(payload.length);
        hdr.putInt(crc);
        hdr.putInt(cmd ^ 0xFFFFFFFF);
        out.write(hdr.array());
        if (payload.length > 0) {
            out.write(payload);
        }
        out.flush();
    }

    private static int[] readHeader(InputStream in) throws Exception {
        byte[] hdr = new byte[24];
        int off = 0;
        while (off < 24) {
            int n = in.read(hdr, off, 24 - off);
            if (n < 0) return null;
            off += n;
        }
        ByteBuffer bb = ByteBuffer.wrap(hdr).order(ByteOrder.LITTLE_ENDIAN);
        return new int[]{bb.getInt(), bb.getInt(), bb.getInt(), bb.getInt(), bb.getInt(), bb.getInt()};
    }

    private static byte[] readExact(InputStream in, int len) throws Exception {
        byte[] buf = new byte[len];
        int off = 0;
        while (off < len) {
            int n = in.read(buf, off, len - off);
            if (n < 0) return buf;
            off += n;
        }
        return buf;
    }

    public static String runShell(int port, String shellCmd, int timeoutMs) {
        try (Socket sock = new Socket()) {
            sock.connect(new InetSocketAddress("127.0.0.1", port), timeoutMs);
            sock.setSoTimeout(timeoutMs);
            OutputStream out = sock.getOutputStream();
            InputStream in = sock.getInputStream();

            sendPacket(out, A_CNXN, 0x01000000, 4096, "host::toolbox-agent\0".getBytes(StandardCharsets.UTF_8));
            int[] h = readHeader(in);
            if (h == null) return null;
            if (h[3] > 0) readExact(in, h[3]);
            if (h[0] == A_AUTH) {
                return null;
            }
            if (h[0] != A_CNXN) {
                return null;
            }

            byte[] openPayload = ("shell:" + shellCmd + "\0").getBytes(StandardCharsets.UTF_8);
            sendPacket(out, A_OPEN, 1, 0, openPayload);

            ByteArrayOutputStream result = new ByteArrayOutputStream();
            for (int i = 0; i < 16; i++) {
                int[] rh = readHeader(in);
                if (rh == null) break;
                byte[] body = rh[3] > 0 ? readExact(in, rh[3]) : new byte[0];
                if (rh[0] == A_WRTE) {
                    result.write(body);
                    sendPacket(out, A_OKAY, 1, rh[1], null);
                } else if (rh[0] == A_CLSE) {
                    break;
                } else if (rh[0] == A_OKAY) {
                    // channel opened; continue reading output or return for fire-and-forget
                }
            }
            return result.toString("UTF-8");
        } catch (Exception e) {
            return null;
        }
    }

    public static boolean isAvailable(int port) {
        String out = runShell(port, "echo ok", 2000);
        return out != null && out.contains("ok");
    }
}
