package de.digitalcoreoffice;

import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.res.Configuration;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.view.Gravity;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceError;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebStorage;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import androidx.activity.OnBackPressedCallback;
import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.graphics.Insets;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import com.google.android.gms.tasks.Task;
import com.google.android.material.button.MaterialButton;
import com.google.android.material.textfield.TextInputEditText;
import com.google.android.material.textfield.TextInputLayout;
import com.google.mlkit.vision.codescanner.GmsBarcodeScanner;
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions;
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning;
import com.google.mlkit.vision.barcode.common.Barcode;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.FileInputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends AppCompatActivity {
    private static final String PREFS = "digital-core-office";
    private static final String SERVER = "server-url";
    private final ExecutorService networkExecutor = Executors.newSingleThreadExecutor();
    private WebView webView;
    private ValueCallback<Uri[]> fileChooser;
    private String serverUrl;
    private NativeExport pendingExport;
    private boolean savingExport;
    private String downloadScript;

    @Override protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (savedInstanceState != null && savedInstanceState.containsKey("pending-export")) {
            try { pendingExport = NativeExport.restore(getCacheDir(), savedInstanceState.getString("pending-export"), savedInstanceState.getString("export-name"), savedInstanceState.getString("export-mime")); }
            catch (Exception ignored) { pendingExport = null; }
        }
        WindowCompat.setDecorFitsSystemWindows(getWindow(), true);
        WindowInsetsControllerCompat systemBars = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        boolean lightTheme = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) != Configuration.UI_MODE_NIGHT_YES;
        systemBars.setAppearanceLightStatusBars(lightTheme);
        systemBars.setAppearanceLightNavigationBars(lightTheme);
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override public void handleOnBackPressed() {
                if (webView != null && webView.canGoBack()) webView.goBack(); else finish();
            }
        });
        serverUrl = getSharedPreferences(PREFS, MODE_PRIVATE).getString(SERVER, "");
        if (serverUrl != null && !serverUrl.isBlank()) {
            try { serverUrl = ServerAddress.normalize(serverUrl); }
            catch (IllegalArgumentException ignored) { serverUrl = ""; getSharedPreferences(PREFS, MODE_PRIVATE).edit().remove(SERVER).apply(); }
        }
        if (serverUrl == null || serverUrl.isBlank()) showServerSetup(); else showOffice(serverUrl, getIntent());
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (serverUrl != null && !serverUrl.isBlank() && webView != null) loadIntentOrHome(intent);
    }

    private void showServerSetup() {
        if (webView != null) { webView.stopLoading(); webView.destroy(); }
        webView = null;
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setBackgroundColor(getColor(R.color.office_background));
        applyWindowInsets(scroll);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        root.setPadding(dp(24), dp(24), dp(24), dp(24));
        scroll.addView(root, new ScrollView.LayoutParams(ScrollView.LayoutParams.MATCH_PARENT, ScrollView.LayoutParams.WRAP_CONTENT));

        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setBackgroundResource(R.drawable.setup_card);
        card.setPadding(dp(24), dp(26), dp(24), dp(26));
        LinearLayout.LayoutParams cardParams = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        cardParams.width = Math.min(getResources().getDisplayMetrics().widthPixels - dp(48), dp(520));

        TextView mark = text(getString(R.string.app_name), 14, getColor(R.color.brand_teal));
        mark.setTypeface(null, android.graphics.Typeface.BOLD);
        TextView title = text(getString(R.string.setup_title), 25, getColor(R.color.office_text));
        ViewCompat.setAccessibilityHeading(title, true);
        TextView explanation = text(getString(R.string.setup_explanation), 15, getColor(R.color.office_muted));
        TextInputLayout field = new TextInputLayout(this, null, com.google.android.material.R.attr.textInputOutlinedStyle);
        field.setId(R.id.server_address_field);
        field.setHint(getString(R.string.server_address));
        field.setPlaceholderText(getString(R.string.server_hint));
        field.setErrorEnabled(true);
        TextInputEditText input = new TextInputEditText(field.getContext());
        input.setId(R.id.server_address_input);
        input.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_URI);
        input.setImeOptions(android.view.inputmethod.EditorInfo.IME_ACTION_GO);
        input.setSingleLine(true);
        input.setText(serverUrl);
        input.setTextColor(getColor(R.color.office_text));
        input.setMinimumHeight(dp(56));
        field.addView(input, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));
        TextView next = text(getString(R.string.setup_next), 14, getColor(R.color.office_muted));
        Button connect = new MaterialButton(this);
        connect.setId(R.id.connect_server);
        connect.setText(R.string.connect);
        connect.setAllCaps(false);
        connect.setLetterSpacing(0);
        connect.setMinimumHeight(dp(50));
        ProgressBar progress = new ProgressBar(this);
        progress.setVisibility(View.GONE);

        card.addView(mark, spaced(0, 0, 0, 10));
        card.addView(title, spaced(0, 0, 0, 8));
        card.addView(explanation, spaced(0, 0, 0, 22));
        card.addView(field, spaced(0, 0, 0, 0));
        card.addView(next, spaced(0, 0, 0, 18));
        card.addView(connect, spaced(0, 0, 0, 8));
        LinearLayout.LayoutParams progressParams = new LinearLayout.LayoutParams(dp(28), dp(28));
        progressParams.gravity = Gravity.CENTER_HORIZONTAL;
        progress.setContentDescription(getString(R.string.checking_server));
        card.addView(progress, progressParams);
        root.addView(card, cardParams);
        setContentView(scroll);

        connect.setOnClickListener(view -> {
            final String normalized;
            try { normalized = ServerAddress.normalize(input.getText().toString()); }
            catch (IllegalArgumentException exception) { field.setError(getString(R.string.invalid_server)); input.requestFocus(); return; }
            WindowInsetsControllerCompat keyboard = ViewCompat.getWindowInsetsController(input);
            if (keyboard != null) keyboard.hide(WindowInsetsCompat.Type.ime());
            connect.setEnabled(false); input.setEnabled(false); progress.setVisibility(View.VISIBLE); field.setError(null);
            connect.setText(R.string.checking_server);
            networkExecutor.submit(() -> validateServer(normalized, (valid, message) -> runOnUiThread(() -> {
                // A rotation or exit must not save a host or open a destroyed activity.
                if (isFinishing() || isDestroyed() || !input.isAttachedToWindow()) return;
                if (valid) {
                    serverUrl = normalized;
                    getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(SERVER, normalized).apply();
                    showOffice(normalized, getIntent());
                } else {
                    connect.setEnabled(true); connect.setText(R.string.connect); input.setEnabled(true); progress.setVisibility(View.GONE); field.setError(message);
                }
            })));
        });
        input.setOnEditorActionListener((view, action, event) -> {
            if (action == android.view.inputmethod.EditorInfo.IME_ACTION_GO) {
                if (connect.isEnabled()) connect.performClick();
                return true;
            }
            return false;
        });
    }

    private void applyWindowInsets(View root) {
        ViewCompat.setOnApplyWindowInsetsListener(root, (view, insets) -> {
            Insets safe = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout() | WindowInsetsCompat.Type.ime());
            view.setPadding(safe.left, safe.top, safe.right, safe.bottom);
            return insets;
        });
    }

    private void showOffice(String baseUrl, Intent launchIntent) {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(getColor(R.color.office_background));
        applyWindowInsets(root);
        // The website already exposes optional server switching at sign-in through
        // the origin-restricted bridge. Let the workplace use the full content area.
        FrameLayout browser = new FrameLayout(this);
        webView = new WebView(this);
        ProgressBar loading = new ProgressBar(this);
        FrameLayout.LayoutParams loadingParams = new FrameLayout.LayoutParams(dp(44), dp(44), Gravity.CENTER);
        browser.addView(webView, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        browser.addView(loading, loadingParams);
        LinearLayout recovery = new LinearLayout(this);
        recovery.setOrientation(LinearLayout.VERTICAL); recovery.setGravity(Gravity.CENTER); recovery.setPadding(dp(24), dp(24), dp(24), dp(24));
        recovery.setBackgroundColor(getColor(R.color.office_background)); recovery.setVisibility(View.GONE);
        recovery.addView(text(getString(R.string.unreachable_server), 18, getColor(R.color.office_text)));
        Button retry = new Button(this); retry.setText(R.string.retry_connection); retry.setOnClickListener(view -> webView.reload()); recovery.addView(retry);
        Button change = new Button(this); change.setId(R.id.recovery_change_server); change.setText(R.string.change); change.setOnClickListener(view -> confirmServerChange()); recovery.addView(change);
        browser.addView(recovery, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        root.addView(browser, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1));
        setContentView(root);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setUserAgentString(settings.getUserAgentString() + " DigitalCoreOfficeAndroid/1.0");
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false);
        if (WebViewFeature.isFeatureSupported(WebViewFeature.START_SAFE_BROWSING)) WebViewCompat.startSafeBrowsing(this, null);

        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(webView, "DigitalCoreOfficeAndroid", Collections.singleton(ServerAddress.origin(baseUrl)), this::handleBridgeMessage);
            WebViewCompat.addWebMessageListener(webView, "DigitalCoreOfficeDownloads", Collections.singleton(ServerAddress.origin(baseUrl)), this::handleDownloadMessage);
            if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
                WebViewCompat.addDocumentStartJavaScript(webView, downloadScript(), Collections.singleton(ServerAddress.origin(baseUrl)));
            }
        }
        webView.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                if (url.startsWith("blob:") || url.startsWith("data:")) { captureBrowserDownload(view, url, "", ""); return true; }
                if (ServerAddress.belongsToServer(serverUrl, url)) return false;
                openExternal(url); return true;
            }
            @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap icon) {
                if (pendingExport != null && !pendingExport.isReady() && !savingExport) { pendingExport.close(); pendingExport = null; }
                loading.setVisibility(View.VISIBLE); recovery.setVisibility(View.GONE);
            }
            @Override public void onPageFinished(WebView view, String url) {
                loading.setVisibility(View.GONE);
                if (ServerAddress.belongsToServer(serverUrl, url)) view.evaluateJavascript(downloadScript(), null);
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) { loading.setVisibility(View.GONE); recovery.setVisibility(View.VISIBLE); }
            }
            @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse error) {
                if (request.isForMainFrame() && error.getStatusCode() >= 400) { loading.setVisibility(View.GONE); recovery.setVisibility(View.VISIBLE); }
            }
            @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, android.net.http.SslError error) {
                handler.cancel(); loading.setVisibility(View.GONE); recovery.setVisibility(View.VISIBLE); Toast.makeText(MainActivity.this, R.string.ssl_error, Toast.LENGTH_LONG).show();
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileChooser != null) fileChooser.onReceiveValue(null);
                fileChooser = callback;
                try { startActivityForResult(params.createIntent(), 41); }
                catch (ActivityNotFoundException exception) { fileChooser = null; Toast.makeText(MainActivity.this, R.string.file_picker_error, Toast.LENGTH_LONG).show(); return false; }
                return true;
            }
        });
        webView.setDownloadListener(downloadListener());
        loadIntentOrHome(launchIntent);
    }

    private void handleBridgeMessage(@NonNull WebView view, @NonNull WebMessageCompat message, @NonNull Uri sourceOrigin, boolean isMainFrame, @NonNull JavaScriptReplyProxy reply) {
        if (webView != view || !trustedBridgeOrigin(sourceOrigin)) return;
        try {
            JSONObject payload = new JSONObject(message.getData());
            String requestId = payload.optString("requestId");
            switch (payload.optString("action")) {
                case "scanQr" -> startQrScan(requestId, reply);
                case "changeServer" -> runOnUiThread(this::confirmServerChange);
                default -> reply.postMessage(response(requestId, null, "Unsupported app action.").toString());
            }
        } catch (Exception exception) {
            reply.postMessage(response("", null, "Invalid app request.").toString());
        }
    }

    private String downloadScript() {
        if (downloadScript == null) {
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(getAssets().open("download-bridge.js"), StandardCharsets.UTF_8))) {
                StringBuilder text = new StringBuilder(); String line;
                while ((line = reader.readLine()) != null) text.append(line).append('\n');
                downloadScript = text.toString();
            } catch (Exception error) { downloadScript = ""; }
        }
        return downloadScript;
    }

    private void captureBrowserDownload(WebView view, String url, String name, String mime) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) { Toast.makeText(this, R.string.update_webview_exports, Toast.LENGTH_LONG).show(); return; }
        view.evaluateJavascript(downloadScript() + "\nwindow.DcoNativeDownloads && window.DcoNativeDownloads.capture(" + JSONObject.quote(url) + "," + JSONObject.quote(name) + "," + JSONObject.quote(mime) + ");", null);
    }

    private void handleDownloadMessage(@NonNull WebView view, @NonNull WebMessageCompat message, @NonNull Uri sourceOrigin, boolean isMainFrame, @NonNull JavaScriptReplyProxy reply) {
        if (webView != view || !trustedBridgeOrigin(sourceOrigin)) return;
        String requestId = "";
        boolean ownsTransfer = false;
        try {
            String raw = message.getData();
            if (raw == null || raw.length() > NativeExport.MAX_CHUNK_CHARS + 2048) throw new IllegalArgumentException("Export message is too large.");
            JSONObject payload = new JSONObject(raw); requestId = payload.optString("requestId");
            String action = payload.optString("action");
            if (action.equals("startExport")) {
                if (pendingExport != null) throw new IllegalArgumentException(getString(R.string.export_in_progress));
                pendingExport = new NativeExport(getCacheDir(), payload.optString("name"), payload.optString("mime"), payload.getLong("size"));
                reply.postMessage(response(requestId, pendingExport.id, null).toString()); return;
            }
            if (pendingExport == null || !pendingExport.id.equals(payload.optString("exportId")) || savingExport) throw new IllegalArgumentException("This export is no longer available.");
            ownsTransfer = true;
            switch (action) {
                case "appendExport" -> { pendingExport.append(payload.getInt("sequence"), payload.getString("chunk")); reply.postMessage(response(requestId, "ok", null).toString()); }
                case "finishExport" -> {
                    pendingExport.finish();
                    Intent save = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(pendingExport.mimeType).putExtra(Intent.EXTRA_TITLE, pendingExport.filename);
                    startActivityForResult(save, 42);
                    reply.postMessage(response(requestId, "ready", null).toString());
                }
                case "cancelExport" -> { pendingExport.close(); pendingExport = null; reply.postMessage(response(requestId, "cancelled", null).toString()); }
                default -> throw new IllegalArgumentException("Unsupported export action.");
            }
        } catch (Exception error) {
            if (ownsTransfer && pendingExport != null && !savingExport) { pendingExport.close(); pendingExport = null; }
            reply.postMessage(response(requestId, null, error.getMessage() == null ? getString(R.string.export_failed) : error.getMessage()).toString());
        }
    }

    private boolean trustedBridgeOrigin(Uri sourceOrigin) {
        try { return serverUrl != null && !serverUrl.isBlank() && ServerAddress.origin(serverUrl).equals(ServerAddress.origin(sourceOrigin.toString())); }
        catch (IllegalArgumentException ignored) { return false; }
    }

    private void startQrScan(String requestId, JavaScriptReplyProxy reply) {
        GmsBarcodeScannerOptions options = new GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).enableAutoZoom().build();
        GmsBarcodeScanner scanner = GmsBarcodeScanning.getClient(this, options);
        Task<Barcode> task = scanner.startScan();
        task.addOnSuccessListener(barcode -> reply.postMessage(response(requestId, barcode.getRawValue(), null).toString()));
        task.addOnCanceledListener(() -> reply.postMessage(response(requestId, null, getString(R.string.scan_cancelled)).toString()));
        task.addOnFailureListener(error -> reply.postMessage(response(requestId, null, getString(R.string.scan_failed)).toString()));
    }

    private void confirmServerChange() {
        new AlertDialog.Builder(this).setTitle(R.string.change_server).setMessage(R.string.change_server_explanation)
            .setNegativeButton(android.R.string.cancel, null).setPositiveButton(R.string.change, (dialog, which) -> {
                if (savingExport) { Toast.makeText(this, R.string.export_in_progress, Toast.LENGTH_LONG).show(); return; }
                if (pendingExport != null) { pendingExport.close(); pendingExport = null; }
                if (webView != null) {
                    webView.stopLoading(); webView.clearCache(true); webView.clearHistory(); webView.clearFormData();
                    webView.destroy(); webView = null;
                }
                if (fileChooser != null) { fileChooser.onReceiveValue(null); fileChooser = null; }
                // Discard the old workplace link while retaining Android's launch metadata.
                getIntent().setData(null);
                CookieManager.getInstance().removeAllCookies(removed -> runOnUiThread(() -> {
                    CookieManager.getInstance().flush(); WebStorage.getInstance().deleteAllData();
                    getSharedPreferences(PREFS, MODE_PRIVATE).edit().remove(SERVER).apply();
                    serverUrl = "";
                    if (!isFinishing() && !isDestroyed()) showServerSetup();
                }));
            }).show();
    }

    private void validateServer(String baseUrl, ValidationCallback callback) {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(ServerAddress.healthUrl(baseUrl)).openConnection();
            connection.setConnectTimeout(10_000); connection.setReadTimeout(10_000); connection.setInstanceFollowRedirects(false);
            connection.setRequestProperty("Accept", "application/json");
            int status = connection.getResponseCode();
            if (status != 200) {
                callback.complete(false, getString(status >= 500 ? R.string.unreachable_server : R.string.incompatible_server));
                return;
            }
            StringBuilder body = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(connection.getInputStream(), StandardCharsets.UTF_8))) {
                char[] buffer = new char[2048]; int count;
                while ((count = reader.read(buffer)) != -1) {
                    if (body.length() + count > 64 * 1024) { callback.complete(false, getString(R.string.incompatible_server)); return; }
                    body.append(buffer, 0, count);
                }
            }
            JSONObject health = new JSONObject(body.toString());
            boolean valid = health.optBoolean("ok") && "digital-core-office-core".equals(health.optString("service")) && health.optInt("apiVersion") == 1;
            callback.complete(valid, valid ? "" : getString(R.string.incompatible_server));
        } catch (org.json.JSONException exception) { callback.complete(false, getString(R.string.incompatible_server)); }
        catch (Exception exception) { callback.complete(false, getString(R.string.unreachable_server)); }
        finally { if (connection != null) connection.disconnect(); }
    }

    private void loadIntentOrHome(Intent intent) {
        Uri data = intent == null ? null : intent.getData();
        String target = data != null && ServerAddress.belongsToServer(serverUrl, data.toString()) ? data.toString() : serverUrl;
        webView.loadUrl(target);
    }

    private void openExternal(String url) {
        try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))); }
        catch (ActivityNotFoundException ignored) { Toast.makeText(this, R.string.no_browser, Toast.LENGTH_LONG).show(); }
    }

    private DownloadListener downloadListener() {
        return (url, userAgent, contentDisposition, mimeType, contentLength) -> {
            if (url.startsWith("blob:") || url.startsWith("data:")) {
                captureBrowserDownload(webView, url, android.webkit.URLUtil.guessFileName(url, contentDisposition, mimeType), mimeType); return;
            }
            if (!ServerAddress.belongsToServer(serverUrl, url)) { openExternal(url); return; }
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
            request.setMimeType(mimeType); request.addRequestHeader("Cookie", CookieManager.getInstance().getCookie(url));
            request.addRequestHeader("User-Agent", userAgent); request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, android.webkit.URLUtil.guessFileName(url, contentDisposition, mimeType));
            ((DownloadManager) getSystemService(DOWNLOAD_SERVICE)).enqueue(request);
        };
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == 41 && fileChooser != null) {
            fileChooser.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data)); fileChooser = null;
        }
        if (requestCode == 42 && pendingExport != null) {
            NativeExport export = pendingExport;
            if (resultCode != RESULT_OK || data == null || data.getData() == null) { export.close(); pendingExport = null; Toast.makeText(this, R.string.export_cancelled, Toast.LENGTH_SHORT).show(); return; }
            Uri destination = data.getData(); savingExport = true;
            networkExecutor.submit(() -> {
                boolean success = false;
                try (FileInputStream input = new FileInputStream(export.file); OutputStream output = getContentResolver().openOutputStream(destination, "wt")) {
                    if (output == null || !export.isReady()) throw new IllegalStateException("Export destination is unavailable.");
                    byte[] buffer = new byte[64 * 1024]; int read;
                    while ((read = input.read(buffer)) != -1) output.write(buffer, 0, read);
                    output.flush(); success = true;
                } catch (Exception ignored) {}
                export.close(); final boolean saved = success;
                runOnUiThread(() -> { if (pendingExport == export) pendingExport = null; savingExport = false; Toast.makeText(this, saved ? R.string.export_saved : R.string.export_failed, Toast.LENGTH_LONG).show(); });
            });
        }
    }

    @Override protected void onSaveInstanceState(@NonNull Bundle state) {
        if (pendingExport != null && pendingExport.isReady() && !savingExport) {
            state.putString("pending-export", pendingExport.file.getAbsolutePath()); state.putString("export-name", pendingExport.filename); state.putString("export-mime", pendingExport.mimeType);
        }
        super.onSaveInstanceState(state);
    }

    @Override protected void onDestroy() {
        if (webView != null) { webView.stopLoading(); webView.destroy(); }
        if (pendingExport != null && !savingExport && !(isChangingConfigurations() && pendingExport.isReady())) pendingExport.close();
        networkExecutor.shutdownNow(); super.onDestroy();
    }

    private JSONObject response(String requestId, String value, String error) {
        JSONObject payload = new JSONObject();
        try { payload.put("requestId", requestId); if (value != null) payload.put("value", value); if (error != null) payload.put("error", error); }
        catch (Exception ignored) {}
        return payload;
    }
    private TextView text(String value, float size, int color) { TextView view = new TextView(this); view.setText(value); view.setTextSize(size); view.setTextColor(color); return view; }
    private LinearLayout.LayoutParams spaced(int l, int t, int r, int b) { LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT); p.setMargins(dp(l), dp(t), dp(r), dp(b)); return p; }
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private interface ValidationCallback { void complete(boolean valid, String message); }
}
