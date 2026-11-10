package de.digitalcoreoffice;

import static androidx.test.espresso.Espresso.onView;
import static androidx.test.espresso.action.ViewActions.*;
import static androidx.test.espresso.assertion.ViewAssertions.matches;
import static androidx.test.espresso.matcher.RootMatchers.isDialog;
import static androidx.test.espresso.matcher.ViewMatchers.*;
import static org.junit.Assert.*;
import static org.junit.Assume.assumeTrue;

import android.content.Context;
import android.graphics.Bitmap;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import android.webkit.CookieManager;
import androidx.test.core.app.ActivityScenario;
import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/** Opt-in, read-only acceptance against a real deployment; no work records are created. */
@RunWith(AndroidJUnit4.class)
public class LiveServerTest {
    @Test public void chosenHostLoadsLoginAndIsRemembered() throws Exception {
        String host = InstrumentationRegistry.getArguments().getString("dcoLiveHost", "");
        assumeTrue("Pass dcoLiveHost to run network acceptance", !host.isBlank());
        String normalized = ServerAddress.normalize(host);
        Context context = ApplicationProvider.getApplicationContext();
        context.getSharedPreferences("digital-core-office", Context.MODE_PRIVATE).edit().clear().commit();
        CountDownLatch cookiesCleared = new CountDownLatch(1);
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> CookieManager.getInstance().removeAllCookies(value -> cookiesCleared.countDown()));
        assertTrue(cookiesCleared.await(3, TimeUnit.SECONDS));
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            capture(context, "host-setup");
            onView(withId(R.id.server_address_input)).perform(scrollTo(), replaceText(host), closeSoftKeyboard());
            // Exercise the keyboard action as well as the button in the other tests.
            onView(withId(R.id.server_address_input)).perform(pressImeActionButton());
            awaitJs(scenario, "location.origin === " + JSONObject.quote(normalized) + " && Boolean(document.querySelector('input[name=email]') && document.querySelector('input[name=password]'))");
            assertEquals(normalized, context.getSharedPreferences("digital-core-office", Context.MODE_PRIVATE).getString("server-url", ""));
            assertWorkplaceFillsContent(scenario);
            awaitLoginServerAction(scenario);
            capture(context, "live-login");
            scenario.recreate();
            awaitJs(scenario, "Boolean(document.querySelector('input[name=password]'))");
            assertWorkplaceFillsContent(scenario);
            awaitLoginServerAction(scenario);
            if ("true".equals(InstrumentationRegistry.getArguments().getString("dcoDarkPreview"))) {
                scenario.onActivity(activity -> findWebView(activity.findViewById(android.R.id.content)).evaluateJavascript("localStorage.setItem('digital-core-office.theme','dark');localStorage.setItem('digital-core-office.language','de');location.reload()", null));
                awaitJs(scenario, "document.querySelector('button[title=\"Helles Design\"]') && document.querySelector('input[name=password]')");
                capture(context, "dark-login");
            }

            // Optional credentials are pushed privately at runtime, never compiled into the APK.
            File credentialsFile = new File(context.getExternalFilesDir(null), "live-test-credentials.json");
            if (credentialsFile.exists()) {
                JSONObject credentials;
                try { credentials = new JSONObject(new String(Files.readAllBytes(credentialsFile.toPath()), StandardCharsets.UTF_8)); }
                finally { Files.deleteIfExists(credentialsFile.toPath()); }
                assertEquals("Credentials may only be sent to their specified host", normalized, ServerAddress.normalize(credentials.getString("host")));
                String script = "(()=>{const email=document.querySelector('input[name=email]'); const password=document.querySelector('input[name=password]'); email.value=" + JSONObject.quote(credentials.getString("email")) + ";password.value=" + JSONObject.quote(credentials.getString("password")) + ";email.form.requestSubmit();})()";
                scenario.onActivity(activity -> findWebView(activity.findViewById(android.R.id.content)).evaluateJavascript(script, null));
                awaitJs(scenario, "document.querySelectorAll('button[data-module]').length === 3 && !document.querySelector('input[name=password]')");
                // Verify shared-session access without clocking in or modifying any records.
                for (String module : new String[]{"time", "inventory", "agile"}) {
                    scenario.onActivity(activity -> findWebView(activity.findViewById(android.R.id.content)).evaluateJavascript("document.querySelector('button[data-module=" + module + "]').click()", null));
                    System.out.println("Checking signed-in module: " + module);
                    // Assert authenticated workspace controls; Time also has a hidden Zeitguru password field.
                    String control = module.equals("time") ? ".clock-actions" : module.equals("inventory") ? ".inventory-content, .mobile-app-header" : ".workspace-sync";
                    awaitJs(scenario, "(()=>{const frame=document.querySelector('iframe.core-workspace-frame');const doc=frame?.contentDocument;return Boolean(doc?.querySelector(" + JSONObject.quote(control) + "));})()");
                    assertWorkplaceFillsContent(scenario);
                    capture(context, "signed-in-" + module);
                    scenario.onActivity(activity -> findWebView(activity.findViewById(android.R.id.content)).loadUrl(normalized));
                    awaitJs(scenario, "document.querySelectorAll('button[data-module]').length === 3");
                }
                scenario.onActivity(activity -> findWebView(activity.findViewById(android.R.id.content)).evaluateJavascript("document.querySelector('button[title=\"Abmelden\"],button[title=\"Sign out\"]').click()", null));
                awaitJs(scenario, "Boolean(document.querySelector('input[name=password]'))");
                awaitLoginServerAction(scenario);
                capture(context, "signed-out-login");
            }

            scenario.onActivity(activity -> findWebView(activity.findViewById(android.R.id.content)).evaluateJavascript("document.querySelector('button[title=\"Server wechseln\"],button[title=\"Change server\"]').click()", null));
            // Cancel keeps the current login and selected host intact.
            onView(withText(android.R.string.cancel)).inRoot(isDialog()).perform(click());
            assertEquals(normalized, context.getSharedPreferences("digital-core-office", Context.MODE_PRIVATE).getString("server-url", ""));
            awaitLoginServerAction(scenario);
            scenario.onActivity(activity -> findWebView(activity.findViewById(android.R.id.content)).evaluateJavascript("document.querySelector('button[title=\"Server wechseln\"],button[title=\"Change server\"]').click()", null));
            onView(withText(R.string.change)).inRoot(isDialog()).perform(click());
            onView(withText(R.string.setup_title)).check(matches(isDisplayed()));
            assertEquals("", context.getSharedPreferences("digital-core-office", Context.MODE_PRIVATE).getString("server-url", ""));
            onView(withId(R.id.server_address_input)).perform(scrollTo(), replaceText(host), closeSoftKeyboard());
            onView(withId(R.id.connect_server)).perform(scrollTo(), click());
            awaitJs(scenario, "Boolean(document.querySelector('input[name=password]'))");
            // Reconnecting must require login, including after the optional signed-in check.
        }
    }

    private static void awaitLoginServerAction(ActivityScenario<MainActivity> scenario) throws Exception {
        awaitJs(scenario, "Boolean(document.querySelector('input[name=password]') && document.querySelector('button[title=\"Server wechseln\"],button[title=\"Change server\"]') && window.DigitalCoreOfficeAndroid)");
    }

    static void assertWorkplaceFillsContent(ActivityScenario<MainActivity> scenario) {
        scenario.onActivity(activity -> {
            WebView browser = findWebView(activity.findViewById(android.R.id.content));
            View frame = (View) browser.getParent();
            View root = (View) frame.getParent();
            assertEquals("No persistent native server bar above the website", root.getPaddingTop(), frame.getTop());
            assertEquals("The website fills the usable height", root.getHeight() - root.getPaddingTop() - root.getPaddingBottom(), browser.getHeight());
        });
    }

    static void awaitRecovery(ActivityScenario<MainActivity> scenario) throws Exception {
        for (int attempt = 0; attempt < 150; attempt++) {
            AtomicBoolean visible = new AtomicBoolean();
            scenario.onActivity(activity -> visible.set(activity.findViewById(R.id.recovery_change_server).isShown()));
            if (visible.get()) return;
            Thread.sleep(100);
        }
        fail("The offline recovery action must appear when the website cannot load");
    }

    static void awaitJs(ActivityScenario<MainActivity> scenario, String condition) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
        while (System.nanoTime() < deadline) {
            CountDownLatch result = new CountDownLatch(1);
            AtomicBoolean ready = new AtomicBoolean();
            scenario.onActivity(activity -> {
                WebView view = findWebView(activity.findViewById(android.R.id.content));
                if (view == null) { result.countDown(); return; }
                view.evaluateJavascript("Boolean(" + condition + ")", value -> { ready.set("true".equals(value)); result.countDown(); });
            });
            assertTrue("WebView responded", result.await(3, TimeUnit.SECONDS));
            if (ready.get()) return;
            Thread.sleep(100);
        }
        capture(ApplicationProvider.getApplicationContext(), "live-failure");
        CountDownLatch diagnostic = new CountDownLatch(1);
        scenario.onActivity(activity -> {
            WebView view = findWebView(activity.findViewById(android.R.id.content));
            if (view == null) { diagnostic.countDown(); return; }
            view.evaluateJavascript("JSON.stringify({url:location.href,bodyLength:document.body?.innerText.length,frames:[...document.querySelectorAll('iframe')].map(f=>({src:f.src,bodyLength:f.contentDocument?.body?.innerText.length})),password:Boolean(document.querySelector('input[type=password]'))})", value -> { System.out.println("Page diagnostic: " + value); diagnostic.countDown(); });
        });
        diagnostic.await(3, TimeUnit.SECONDS);
        fail("Expected live page state was not reached: " + condition);
    }

    static void capture(Context context, String name) throws Exception {
        // WebView DOM readiness precedes the compositor frame used by screenshots.
        InstrumentationRegistry.getInstrumentation().waitForIdleSync();
        Thread.sleep(750);
        Bitmap bitmap = InstrumentationRegistry.getInstrumentation().getUiAutomation().takeScreenshot();
        assertNotNull(bitmap);
        try (FileOutputStream output = new FileOutputStream(new File(context.getExternalFilesDir(null), name + ".png"))) {
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, output);
        } finally { bitmap.recycle(); }
    }

    static WebView findWebView(View view) {
        if (view instanceof WebView) return (WebView)view;
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup)view;
            for (int i = 0; i < group.getChildCount(); i++) { WebView found = findWebView(group.getChildAt(i)); if (found != null) return found; }
        }
        return null;
    }
}
