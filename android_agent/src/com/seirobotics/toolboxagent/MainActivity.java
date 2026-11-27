package com.seirobotics.toolboxagent;

import android.app.Activity;
import android.app.AlertDialog;
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
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import org.json.JSONObject;
import java.util.Locale;

public class MainActivity extends Activity {
    private LinearLayout statusCard;
    private TextView badgeView;
    private TextView summaryView;
    private TextView countdownView;
    private TextView detailView;
    private TextView logView;
    private ScrollView logScroll;
    private Button stopBtn;
    private Button resetBtn;
    private Button clearLogBtn;
    private Button localRunBtn;
    private String lastLogText = "";
    private boolean logScrollUnlocked = false;
    private Toast activeToast;
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
        focusSafeDefault();
    }

    private void focusSafeDefault() {
        if (logScroll != null) {
            logScroll.post(logScroll::requestFocus);
            return;
        }
        focusFirstEnabled();
    }

    private void focusFirstEnabled() {
        for (Button btn : new Button[]{localRunBtn, resetBtn, clearLogBtn, stopBtn}) {
            if (btn != null && btn.isEnabled()) {
                btn.post(btn::requestFocus);
                return;
            }
        }
        if (logScroll != null) {
            logScroll.post(logScroll::requestFocus);
        }
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        if (event.getAction() == KeyEvent.ACTION_DOWN) {
            if (getCurrentFocus() == null) {
                focusSafeDefault();
                return true;
            }
            if (logScroll != null && logScroll.hasFocus()) {
                int code = event.getKeyCode();
                if (code == KeyEvent.KEYCODE_DPAD_CENTER || code == KeyEvent.KEYCODE_ENTER) {
                    setLogScrollUnlocked(!logScrollUnlocked, true);
                    return true;
                }
                if (code == KeyEvent.KEYCODE_BACK && logScrollUnlocked) {
                    setLogScrollUnlocked(false, true);
                    return true;
                }
                if (!logScrollUnlocked) {
                    if (code == KeyEvent.KEYCODE_DPAD_DOWN
                            || code == KeyEvent.KEYCODE_PAGE_DOWN
                            || code == KeyEvent.KEYCODE_PAGE_UP) {
                        showHintToast("按 OK 键才可上下移动日志");
                        return true;
                    }
                    if (code == KeyEvent.KEYCODE_DPAD_UP || code == KeyEvent.KEYCODE_DPAD_LEFT) {
                        focusFirstEnabled();
                        return true;
                    }
                } else {
                    if (code == KeyEvent.KEYCODE_DPAD_LEFT || code == KeyEvent.KEYCODE_DPAD_RIGHT) {
                        return true;
                    }
                }
            }
        }
        return super.dispatchKeyEvent(event);
    }

    private void setLogScrollUnlocked(boolean unlocked, boolean showToast) {
        logScrollUnlocked = unlocked;
        updateLogScrollBg();
        if (!unlocked && logScroll != null && logView != null) {
            logScroll.post(() -> logScroll.scrollTo(0, Math.max(0, logView.getHeight())));
        }
        if (showToast) {
            showHintToast(unlocked
                    ? "已解锁日志滚动，可按上下键查看（按 OK 或返回键退出）"
                    : "已退出日志滚动模式");
        }
    }

    private void updateLogScrollBg() {
        if (logScroll == null) return;
        StateListDrawable scrollSld = new StateListDrawable();
        String focusColor = logScrollUnlocked ? "#5CE0A8" : "#58A6FF";
        GradientDrawable scrollFocused = cardBg("#10151C", focusColor);
        scrollFocused.setStroke(3, Color.parseColor(focusColor));
        scrollSld.addState(new int[]{android.R.attr.state_focused}, scrollFocused);
        scrollSld.addState(new int[]{}, cardBg("#10151C", "#1F2A38"));
        logScroll.setBackground(scrollSld);
    }

    private void showHintToast(String msg) {
        if (activeToast != null) {
            activeToast.cancel();
        }
        activeToast = Toast.makeText(this, msg, Toast.LENGTH_SHORT);
        activeToast.show();
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

        statusCard = new LinearLayout(this);
        LinearLayout card = statusCard;
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

        countdownView = new TextView(this);
        countdownView.setTextColor(Color.parseColor("#5CE0A8"));
        countdownView.setTextSize(17);
        countdownView.setTypeface(Typeface.DEFAULT_BOLD);
        countdownView.setPadding(0, 8, 0, 0);
        card.addView(countdownView);

        detailView = new TextView(this);
        detailView.setTextColor(Color.parseColor("#A7B6C8"));
        detailView.setTextSize(15);
        detailView.setLineSpacing(6f, 1.0f);
        detailView.setPadding(0, 10, 0, 0);
        card.addView(detailView);
        root.addView(card);

        LinearLayout btnRow = new LinearLayout(this);
        btnRow.setOrientation(LinearLayout.HORIZONTAL);
        btnRow.setGravity(Gravity.START);

        btnRow.addView(localRunBtn = makeBtn("本地试跑10次", () -> {
            Intent i = new Intent(AgentService.ACTION_START_REBOOT);
            i.putExtra("mode", "count");
            i.putExtra("target_count", 10);
            i.putExtra("stable_sec", 30);
            startAgentService(i);
        }));
        btnRow.addView(resetBtn = makeBtn("重置记录", () -> startAgentService(new Intent(AgentService.ACTION_RESET))));
        btnRow.addView(clearLogBtn = makeBtn("清除日志", () -> {
            AgentStore.clearLog(this);
            refreshUi();
        }));
        btnRow.addView(stopBtn = makeBtn("停止压测", this::confirmStopTest));
        root.addView(btnRow);

        logScroll = new ScrollView(this) {
            @Override
            public boolean onInterceptTouchEvent(MotionEvent ev) {
                return logScrollUnlocked && super.onInterceptTouchEvent(ev);
            }

            @Override
            public boolean onTouchEvent(MotionEvent ev) {
                if (!logScrollUnlocked) return false;
                return super.onTouchEvent(ev);
            }

            @Override
            public boolean onGenericMotionEvent(MotionEvent event) {
                if (!logScrollUnlocked) return false;
                return super.onGenericMotionEvent(event);
            }

            @Override
            public boolean executeKeyEvent(KeyEvent event) {
                if (!logScrollUnlocked) return false;
                return super.executeKeyEvent(event);
            }
        };
        ScrollView scroll = logScroll;
        scroll.setFocusable(true);
        scroll.setOnFocusChangeListener((v, hasFocus) -> {
            if (!hasFocus && logScrollUnlocked) {
                setLogScrollUnlocked(false, false);
            }
        });
        updateLogScrollBg();
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
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.setMargins(0, 0, 16, 0);
        b.setLayoutParams(lp);
        b.setOnClickListener(v -> onClick.run());
        return b;
    }

    private void confirmStopTest() {
        AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle("确认停止压测")
                .setMessage("确定要停止当前正在进行的 Reboot 压测吗？")
                .setNegativeButton("取消", (d, w) -> focusSafeDefault())
                .setPositiveButton("确认停止", (d, w) -> {
                    startAgentService(new Intent(AgentService.ACTION_STOP));
                    focusSafeDefault();
                })
                .setOnCancelListener(d -> focusSafeDefault())
                .create();
        dialog.show();
        Button cancelBtn = dialog.getButton(AlertDialog.BUTTON_NEGATIVE);
        if (cancelBtn != null) {
            cancelBtn.post(cancelBtn::requestFocus);
        }
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
        if (AgentStore.STATE_RUNNING.equals(st)) return "● 压测运行中";
        if (AgentStore.STATE_COMPLETED.equals(st)) return "✓ 压测已完成";
        if (AgentStore.STATE_FAILED.equals(st)) return "✕ 异常失败";
        if (AgentStore.STATE_STOPPED.equals(st)) return "■ 已停止";
        return "○ 未开始测试";
    }

    private void setBtnEnabled(Button btn, boolean enabled) {
        if (btn == null) return;
        boolean wasFocused = btn.isFocused();
        btn.setEnabled(enabled);
        btn.setFocusable(enabled);
        btn.setAlpha(enabled ? 1.0f : 0.35f);
        if (wasFocused && !enabled) {
            focusSafeDefault();
        }
    }

    private void refreshUi() {
        JSONObject st = AgentStore.loadState(this);
        String state = st.optString("state", AgentStore.STATE_IDLE);
        boolean isRunning = AgentStore.STATE_RUNNING.equals(state);
        boolean isIdle = AgentStore.STATE_IDLE.equals(state);
        int curRound = st.optInt("current_round", 0);
        int okCount = st.optInt("success_rounds", 0);
        int failCount = st.optInt("fail_rounds", 0);
        int anomCount = st.optInt("anomaly_count", 0);
        String logs = AgentStore.readTailLog(this, 40);

        setBtnEnabled(stopBtn, isRunning);
        setBtnEnabled(resetBtn, !isRunning && (!isIdle || curRound > 0 || okCount > 0 || failCount > 0 || anomCount > 0));
        setBtnEnabled(clearLogBtn, !logs.trim().isEmpty());
        setBtnEnabled(localRunBtn, !isRunning);

        badgeView.setText(stateLabel(state));
        if (isRunning) {
            badgeView.setTextColor(Color.parseColor("#5CE0A8"));
            badgeView.setBackground(cardBg("#133326", "#2B7A59"));
            GradientDrawable runningCard = cardBg("#12211B", "#2B7A59");
            runningCard.setStroke(4, Color.parseColor("#2B7A59"));
            statusCard.setBackground(runningCard);
        } else if (AgentStore.STATE_FAILED.equals(state)) {
            badgeView.setTextColor(Color.parseColor("#FF8A8A"));
            badgeView.setBackground(cardBg("#3A181B", "#8F333B"));
            GradientDrawable failCard = cardBg("#241517", "#8F333B");
            failCard.setStroke(3, Color.parseColor("#8F333B"));
            statusCard.setBackground(failCard);
        } else if (AgentStore.STATE_COMPLETED.equals(state)) {
            badgeView.setTextColor(Color.parseColor("#7BC4FF"));
            badgeView.setBackground(cardBg("#142A3E", "#2C5E8A"));
            statusCard.setBackground(cardBg("#151C25", "#2C5E8A"));
        } else {
            badgeView.setTextColor(Color.parseColor("#B8C4D4"));
            badgeView.setBackground(cardBg("#1D2530", "#384658"));
            statusCard.setBackground(cardBg("#151C25", "#273445"));
        }

        String mode = st.optString("mode", "count");
        int stableSec = st.optInt("stable_sec", 30);
        String reason = st.optString("last_boot_reason", "").trim();
        boolean selfReboot = st.optBoolean("can_self_reboot", false);

        StringBuilder d = new StringBuilder();
        if (AgentStore.STATE_IDLE.equals(state)) {
            summaryView.setText("未开始测试 · 等待 PC 端发起或点击「本地试跑10次」");
            countdownView.setVisibility(android.view.View.GONE);
            d.append("预设等待期: ").append(stableSec).append(" 秒")
                    .append("    自主重启: ").append(selfReboot ? "支持" : "不支持").append("\n");
            d.append("重启原因: ").append(reason.isEmpty() ? "未获取" : reason);
        } else {
            if ("hours".equals(mode)) {
                double runHours = st.optDouble("run_hours", 1.0);
                long accMs = st.optLong("accumulated_ms", 0L);
                long bootUp = st.optLong("boot_uptime_ms", 0L);
                long liveDelta = (isRunning && bootUp > 0)
                        ? Math.max(0L, SystemClock.elapsedRealtime() - bootUp)
                        : 0L;
                double totalHours = (accMs + liveDelta) / 3600_000.0;
                if (runHours < 1.0) {
                    double totalMin = totalHours * 60.0;
                    double targetMin = Math.round(runHours * 600.0) / 10.0;
                    summaryView.setText(String.format(
                            Locale.US,
                            "按时长压测 · %.1f / %s 分钟（已完成 %d 次）",
                            totalMin,
                            targetMin == Math.rint(targetMin) ? String.valueOf((long) targetMin) : String.valueOf(targetMin),
                            curRound
                    ));
                } else {
                    double roundedHours = Math.round(runHours * 100.0) / 100.0;
                    summaryView.setText(String.format(
                            Locale.US,
                            "按时长压测 · %.2f / %s 小时（已完成 %d 次）",
                            totalHours,
                            roundedHours == Math.rint(roundedHours) ? String.valueOf((long) roundedHours) : String.valueOf(roundedHours),
                            curRound
                    ));
                }
            } else {
                int target = st.optInt("target_count", 10);
                summaryView.setText(String.format(Locale.US, "按次数压测 · 第 %d / %d 次", curRound, target));
            }

            if (isRunning) {
                countdownView.setVisibility(android.view.View.VISIBLE);
                long nextUptime = st.optLong("next_reboot_uptime_ms", 0L);
                if (nextUptime > 0L) {
                    long remainMs = nextUptime - SystemClock.elapsedRealtime();
                    long remainSec = remainMs > 0L ? (remainMs + 999L) / 1000L : 0L;
                    countdownView.setText(remainSec > 0
                            ? "正在压测中 · 距离下次重启还有 " + remainSec + " 秒"
                            : "正在压测中 · 正在执行重启...");
                } else {
                    countdownView.setText("正在压测中 · 正在执行重启...");
                }
            } else {
                countdownView.setVisibility(android.view.View.GONE);
            }

            d.append("成功: ").append(okCount).append(" 次    失败: ").append(failCount)
                    .append(" 次    异常: ").append(anomCount).append(" 次    等待期: ").append(stableSec).append(" 秒\n");
            d.append("重启原因: ").append(reason.isEmpty() ? "未获取" : reason)
                    .append("    自主重启: ").append(selfReboot ? "支持" : "不支持");
            String stopReason = st.optString("stop_reason", "").trim();
            if (!stopReason.isEmpty()) d.append("\n停止原因: ").append(stopReason);
        }
        detailView.setText(d.toString());

        String nextLog = logs.isEmpty() ? "暂无日志" : logs;
        if (!nextLog.equals(lastLogText)) {
            lastLogText = nextLog;
            logView.setText(nextLog);
            if (logScroll != null && !logScrollUnlocked) {
                logScroll.post(() -> logScroll.scrollTo(0, Math.max(0, logView.getHeight())));
            }
        }
    }
}
