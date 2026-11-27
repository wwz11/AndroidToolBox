package com.seirobotics.toolboxagent;

import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import org.json.JSONObject;

public class MainActivity extends Activity {
    private TextView statusView;
    private TextView logView;
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
            handler.postDelayed(this, 2000);
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
        handler.postDelayed(ticker, 2000);
    }

    @Override
    protected void onPause() {
        handler.removeCallbacks(ticker);
        try {
            unregisterReceiver(stateReceiver);
        } catch (Exception ignored) {}
        super.onPause();
    }

    private void buildUi() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.parseColor("#11161D"));
        root.setPadding(48, 36, 48, 36);

        TextView title = new TextView(this);
        title.setText("AndroidTVToolBox 设备端压测 Agent");
        title.setTextColor(Color.parseColor("#F3F6FA"));
        title.setTextSize(24);
        root.addView(title);

        statusView = new TextView(this);
        statusView.setTextColor(Color.parseColor("#B8C4D4"));
        statusView.setTextSize(16);
        statusView.setPadding(0, 20, 0, 20);
        root.addView(statusView);

        LinearLayout btnRow = new LinearLayout(this);
        btnRow.setOrientation(LinearLayout.HORIZONTAL);
        btnRow.setGravity(Gravity.START);

        btnRow.addView(makeBtn("开始 10 次压测", () -> {
            Intent i = new Intent(AgentService.ACTION_START_REBOOT);
            i.putExtra("mode", "count");
            i.putExtra("target_count", 10);
            i.putExtra("stable_sec", 15);
            startAgentService(i);
        }));
        btnRow.addView(makeBtn("停止压测", () -> startAgentService(new Intent(AgentService.ACTION_STOP))));
        btnRow.addView(makeBtn("重置记录", () -> startAgentService(new Intent(AgentService.ACTION_RESET))));
        btnRow.addView(makeBtn("开启网络ADB", () -> startAgentService(new Intent(AgentService.ACTION_ENABLE_TCP_ADB))));
        root.addView(btnRow);

        ScrollView scroll = new ScrollView(this);
        scroll.setPadding(0, 20, 0, 0);
        logView = new TextView(this);
        logView.setTextColor(Color.parseColor("#8FA3B8"));
        logView.setTextSize(13);
        scroll.addView(logView);
        root.addView(scroll, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f));

        setContentView(root);
    }

    private Button makeBtn(String label, Runnable onClick) {
        Button b = new Button(this);
        b.setText(label);
        b.setFocusable(true);
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

    private void refreshUi() {
        JSONObject st = AgentStore.loadState(this);
        StringBuilder sb = new StringBuilder();
        sb.append("状态: ").append(st.optString("state"))
                .append("    模式: ").append(st.optString("mode"))
                .append("    轮次: ").append(st.optInt("current_round"))
                .append("/").append(st.optInt("target_count")).append("\n");
        sb.append("成功: ").append(st.optInt("success_rounds"))
                .append("    失败: ").append(st.optInt("fail_rounds"))
                .append("    异常: ").append(st.optInt("anomaly_count")).append("\n");
        sb.append("设备 IP: ").append(st.optString("ip", "-"))
                .append("    网络ADB端口: ").append(st.optString("adb_tcp_port", "-"))
                .append("    设备自主重启: ").append(st.optBoolean("can_self_reboot") ? "支持" : "需PC辅助").append("\n");
        sb.append("最近重启原因: ").append(st.optString("last_boot_reason", "-"));
        String stopReason = st.optString("stop_reason", "");
        if (!stopReason.isEmpty()) sb.append("\n停止说明: ").append(stopReason);
        statusView.setText(sb.toString());

        String logs = AgentStore.readTailLog(this, 40);
        logView.setText(logs.isEmpty() ? "暂无日志" : logs);
    }
}
