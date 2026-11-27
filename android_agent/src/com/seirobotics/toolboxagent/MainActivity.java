package com.seirobotics.toolboxagent;

import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.StateListDrawable;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.Gravity;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import org.json.JSONObject;
import java.util.Locale;

public class MainActivity extends Activity {
    private TextView badgeView;
    private TextView summaryView;
    private TextView detailView;
    private TextView logView;
    private Button firstBtn;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final BroadcastReceiver stateReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            refreshUi();
        }
    };
    private final Runnable ticker = new Runnable() {
        @Override
        public void run() {
            refreshUi();
            handler.postDelayed(this, 1000);
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        buildUi();
        startAgentService(null);
    }

    @Override
    protected void onResume() {
        super.onResume();
        IntentFilter f = new IntentFilter(AgentService.ACTION_STATE_CHANGED);
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(stateReceiver, f, Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(stateReceiver, f);
        }
        refreshUi();
        handler.postDelayed(ticker, 1000);
        if (firstBtn != null) firstBtn.requestFocus();
    }

    @Override
    protected void onPause() {
        handler.removeCallbacks(ticker);
        try {
            unregisterReceiver(stateReceiver);
        } catch (Exception ignored) {}
        super.onPause();
    }

    private GradientDrawable cardBg(String hexColor, String strokeHex) {
        GradientDrawable d = new GradientDrawable();
        d.setColor(Color.parseColor(hexColor));
        d.setCornerRadius(14f);
        d.setStroke(2, Color.parseColor(strokeHex));
        return d;
    }

    private void buildUi() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.parseColor("#0D1218"));
        root.setPadding(48, 32, 48, 32);

        LinearLayout headerRow = new LinearLayout(this);
        headerRow.setOrientation(LinearLayout.HORIZONTAL);
        headerRow.setGravity(Gravity.CENTER_VERTICAL);

        TextView title = new TextView(this);
        title.setText("AndroidTVToolBox · Reboot 压测终端");
        title.setTextColor(Color.parseColor("#F4F7FB"));
        title.setTextSize(24);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        headerRow.addView(title, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));

        badgeView = new TextView(this);
        badgeView.setTextSize(15);
        badgeView.setTypeface(Typeface.DEFAULT_BOLD);
        badgeView.setPadding(22, 8, 22, 8);
        headerRow.addView(badgeView);
        root.addView(headerRow);

        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setBackground(cardBg("#151C25", "#273445"));
        card.setPadding(28, 22, 28, 22);
        LinearLayout.LayoutParams cardLp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        cardLp.setMargins(0, 18, 0, 16);
        card.setLayoutParams(cardLp);

        summaryView = new TextView(this);
        summaryView.setTextColor(Color.parseColor("#E8EEF5"));
        summaryView.setTextSize(19);
        summaryView.setTypeface(Typeface.DEFAULT_BOLD);
        card.addView(summaryView);

        detailView = new TextView(this);
        detailView.setTextColor(Color.parseColor("#A7B6C8"));
        detailView.setTextSize(15);
        detailView.setLineSpacing(6f, 1.0f);
        detailView.setPadding(0, 12, 0, 0);
        card.addView(detailView);
        root.addView(card);

        LinearLayout btnRow = new LinearLayout(this);
        btnRow.setOrientation(LinearLayout.HORIZONTAL);
        btnRow.setGravity(Gravity.START);

        btnRow.addView(firstBtn = makeBtn("停止压测", () -> startAgentService(new Intent(AgentService.ACTION_STOP))));
        btnRow.addView(makeBtn("重置记录", () -> startAgentService(new Intent(AgentService.ACTION_RESET))));
        btnRow.addView(makeBtn("清除日志", () -> {
            AgentStore.clearLog(this);
            refreshUi();
        }));
        btnRow.addView(makeBtn("开启网络ADB", () -> startAgentService(new Intent(AgentService.ACTION_ENABLE_TCP_ADB))));
        btnRow.addView(makeBtn("本地试跑10次", () -> {
            Intent i = new Intent(AgentService.ACTION_START_REBOOT);
            i.putExtra("mode", "count");
            i.putExtra("target_count", 10);
            i.putExtra("stable_sec", 30);
            startAgentService(i);
        }));
        root.addView(btnRow);

        ScrollView scroll = new ScrollView(this);
        scroll.setFocusable(true);
        StateListDrawable scrollSld = new StateListDrawable();
        GradientDrawable scrollFocused = cardBg("#10151C", "#58A6FF");
        scrollFocused.setStroke(3, Color.parseColor("#58A6FF"));
        scrollSld.addState(new int[]{android.R.attr.state_focused}, scrollFocused);
        scrollSld.addState(new int[]{}, cardBg("#10151C", "#1F2A38"));
        scroll.setBackground(scrollSld);
        scroll.setPadding(22, 16, 22, 16);
        LinearLayout.LayoutParams scrollLp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f);
        scrollLp.setMargins(0, 16, 0, 0);
        scroll.setLayoutParams(scrollLp);

        logView = new TextView(this);
        logView.setTextColor(Color.parseColor("#92A6BD"));
        logView.setTextSize(13);
        logView.setTypeface(Typeface.MONOSPACE);
        scroll.addView(logView);
        root.addView(scroll);

        setContentView(root);
    }

    private StateListDrawable btnBg() {
        StateListDrawable sld = new StateListDrawable();
        GradientDrawable pressed = cardBg("#24527A", "#7BC4FF");
        pressed.setStroke(4, Color.parseColor("#7BC4FF"));
        GradientDrawable focused = cardBg("#2B3D54", "#58A6FF");
        focused.setStroke(4, Color.parseColor("#58A6FF"));
        GradientDrawable normal = cardBg("#1E2836", "#374960");
        sld.addState(new int[]{android.R.attr.state_pressed}, pressed);
        sld.addState(new int[]{android.R.attr.state_focused}, focused);
        sld.addState(new int[]{android.R.attr.state_selected}, focused);
        sld.addState(new int[]{}, normal);
        return sld;
    }

    private Button makeBtn(String label, Runnable onClick) {
        Button b = new Button(this);
        b.setText(label);
        b.setTextColor(Color.parseColor("#EEF3F8"));
        b.setBackground(btnBg());
        b.setPadding(24, 10, 24, 10);
        b.setFocusable(true);
        b.setFocusableInTouchMode(true);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.setMargins(0, 0, 16, 0);
        b.setLayoutParams(lp);
        b.setOnClickListener(v -> onClick.run());
        return b;
    }

    private void startAgentService(Intent extraIntent) {
        Intent svc = new Intent(this, AgentService.class);
        if (extraIntent != null) {
            svc.setAction(extraIntent.getAction());
            if (extraIntent.getExtras() != null) svc.putExtras(extraIntent.getExtras());
        }
        if (Build.VERSION.SDK_INT >= 26) {
            startForegroundService(svc);
        } else {
            startService(svc);
        }
    }

    private String stateLabel(String st) {
        if (AgentStore.STATE_RUNNING.equals(st)) return "压测中";
        if (AgentStore.STATE_COMPLETED.equals(st)) return "已完成";
        if (AgentStore.STATE_FAILED.equals(st)) return "异常失败";
        if (AgentStore.STATE_STOPPED.equals(st)) return "已停止";
        return "空闲";
    }

    private void refreshUi() {
        JSONObject st = AgentStore.loadState(this);
        String state = st.optString("state", AgentStore.STATE_IDLE);
        badgeView.setText(stateLabel(state));
        if (AgentStore.STATE_RUNNING.equals(state)) {
            badgeView.setTextColor(Color.parseColor("#5CE0A8"));
            badgeView.setBackground(cardBg("#133326", "#2B7A59"));
        } else if (AgentStore.STATE_FAILED.equals(state)) {
            badgeView.setTextColor(Color.parseColor("#FF8A8A"));
            badgeView.setBackground(cardBg("#3A181B", "#8F333B"));
        } else if (AgentStore.STATE_COMPLETED.equals(state)) {
            badgeView.setTextColor(Color.parseColor("#7BC4FF"));
            badgeView.setBackground(cardBg("#142A3E", "#2C5E8A"));
        } else {
            badgeView.setTextColor(Color.parseColor("#B8C4D4"));
            badgeView.setBackground(cardBg("#1D2530", "#384658"));
        }

        String mode = st.optString("mode", "count");
        int curRound = st.optInt("current_round", 0);
        int okCount = st.optInt("success_rounds", 0);
        int failCount = st.optInt("fail_rounds", 0);
        int anomCount = st.optInt("anomaly_count", 0);
        int stableSec = st.optInt("stable_sec", 30);

        if ("hours".equals(mode)) {
            double runHours = st.optDouble("run_hours", 1.0);
            long accMs = st.optLong("accumulated_ms", 0L);
            long bootUp = st.optLong("boot_uptime_ms", 0L);
            long liveDelta = (AgentStore.STATE_RUNNING.equals(state) && bootUp > 0)
                    ? Math.max(0L, SystemClock.elapsedRealtime() - bootUp)
                    : 0L;
            double totalHours = (accMs + liveDelta) / 3600_000.0;
            summaryView.setText(String.format(
                    Locale.US,
                    "按时长压测 · %.2f / %s 小时（已完成 %d 次）",
                    totalHours,
                    runHours == Math.rint(runHours) ? String.valueOf((long) runHours) : String.valueOf(runHours),
                    curRound
            ));
        } else {
            int target = st.optInt("target_count", 10);
            summaryView.setText(String.format(Locale.US, "按次数压测 · 第 %d / %d 次", curRound, target));
        }

        String reason = st.optString("last_boot_reason", "").trim();
        if (reason.isEmpty()) reason = DeviceProbe.getBootReason();
        String ip = st.optString("ip", "").trim();
        String tcpPort = st.optString("adb_tcp_port", "").trim();
        boolean selfReboot = st.optBoolean("can_self_reboot", false);

        StringBuilder d = new StringBuilder();
        d.append("成功: ").append(okCount).append(" 次    失败: ").append(failCount)
                .append(" 次    异常: ").append(anomCount).append(" 次    等待期: ").append(stableSec).append(" 秒");
        long nextUptime = st.optLong("next_reboot_uptime_ms", 0L);
        if (AgentStore.STATE_RUNNING.equals(state)) {
            if (nextUptime > 0L) {
                long remainMs = nextUptime - SystemClock.elapsedRealtime();
                long remainSec = remainMs > 0L ? (remainMs + 999L) / 1000L : 0L;
                d.append(remainSec > 0
                        ? "    |    距离下次重启: " + remainSec + " 秒"
                        : "    |    正在执行重启...");
            } else {
                d.append("    |    正在执行重启...");
            }
        }
        d.append("\n");
        d.append("重启原因: ").append(reason.isEmpty() ? "未获取" : reason)
                .append("    自主重启: ").append(selfReboot ? "支持" : "不支持").append("\n");
        d.append("设备 IP: ").append(ip.isEmpty() ? "未连网/仅USB" : ip)
                .append("    本机 ADB 端口: ").append(tcpPort.isEmpty() ? "-" : tcpPort);
        String stopReason = st.optString("stop_reason", "").trim();
        if (!stopReason.isEmpty()) d.append("\n停止原因: ").append(stopReason);
        detailView.setText(d.toString());

        String logs = AgentStore.readTailLog(this, 40);
        logView.setText(logs.isEmpty() ? "暂无日志" : logs);
    }
}
