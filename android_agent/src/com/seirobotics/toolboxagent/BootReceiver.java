package com.seirobotics.toolboxagent;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (Intent.ACTION_LOCKED_BOOT_COMPLETED.equals(intent.getAction())
                && context.getExternalFilesDir(null) == null) {
            return;
        }
        Intent svc = new Intent(context, AgentService.class);
        svc.setAction(AgentService.ACTION_BOOT_EVENT);
        if (Build.VERSION.SDK_INT >= 26) {
            context.startForegroundService(svc);
        } else {
            context.startService(svc);
        }
    }
}
