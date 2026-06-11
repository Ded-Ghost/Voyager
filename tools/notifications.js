'use strict';
const { exec } = require('child_process');
const os       = require('os');

/**
 * Send a native desktop notification.
 * Works on Windows (PowerShell), macOS (osascript), Linux (notify-send).
 */
function sendNotification(title, message, urgency = 'normal') {
  const platform = os.platform();
  const safe = s => s.replace(/'/g, "\\'").replace(/"/g, '\\"').slice(0, 200);

  return new Promise((resolve) => {
    let cmd;

    if (platform === 'win32') {
      cmd = `powershell -NoProfile -Command "` +
        `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null; ` +
        `$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02); ` +
        `$textNodes = $template.GetElementsByTagName('text'); ` +
        `$textNodes.Item(0).AppendChild($template.CreateTextNode('${safe(title)}')) | Out-Null; ` +
        `$textNodes.Item(1).AppendChild($template.CreateTextNode('${safe(message)}')) | Out-Null; ` +
        `$toast = [Windows.UI.Notifications.ToastNotification]::new($template); ` +
        `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('VOYAGER').Show($toast)"`;
    } else if (platform === 'darwin') {
      cmd = `osascript -e 'display notification "${safe(message)}" with title "VOYAGER" subtitle "${safe(title)}"'`;
    } else {
      const urgencyFlag = urgency === 'critical' ? '-u critical' : '-u normal';
      cmd = `notify-send ${urgencyFlag} -a "VOYAGER" "${safe(title)}" "${safe(message)}"`;
    }

    exec(cmd, { timeout: 8000 }, (err) => {
      if (err) {
        // Non-fatal — notification failure shouldn't stop the agent
        resolve({ ok: false, platform, fallback: true, error: err.message });
      } else {
        resolve({ ok: true, platform, title, message });
      }
    });
  });
}

module.exports = { sendNotification };
