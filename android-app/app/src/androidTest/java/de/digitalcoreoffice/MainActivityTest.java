package de.digitalcoreoffice;

import static androidx.test.espresso.Espresso.onView;
import static androidx.test.espresso.action.ViewActions.click;
import static androidx.test.espresso.action.ViewActions.replaceText;
import static androidx.test.espresso.action.ViewActions.closeSoftKeyboard;
import static androidx.test.espresso.action.ViewActions.scrollTo;
import static androidx.test.espresso.matcher.RootMatchers.isDialog;
import static androidx.test.espresso.assertion.ViewAssertions.matches;
import static androidx.test.espresso.matcher.ViewMatchers.isDisplayed;
import static androidx.test.espresso.matcher.ViewMatchers.withText;
import static androidx.test.espresso.matcher.ViewMatchers.withId;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.assertEquals;

import android.Manifest;
import android.content.Context;
import android.app.Activity;
import android.app.Instrumentation;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.Uri;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import android.webkit.CookieManager;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;

import androidx.test.core.app.ActivityScenario;
import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.util.Arrays;
import java.io.File;
import java.nio.file.Files;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

@RunWith(AndroidJUnit4.class)
public class MainActivityTest {
    @Before public void clearServer() {
        ApplicationProvider.getApplicationContext().getSharedPreferences("digital-core-office", Context.MODE_PRIVATE).edit().clear().commit();
    }

    @Test public void firstLaunchShowsServerSetup() {
        try (ActivityScenario<MainActivity> ignored = ActivityScenario.launch(MainActivity.class)) {
            onView(withText(R.string.setup_title)).check(matches(isDisplayed()));
            onView(withText(R.string.connect)).check(matches(isDisplayed()));
            onView(withId(R.id.server_address_input)).check(matches(withText("")));
            assertEquals("", ApplicationProvider.getApplicationContext().getSharedPreferences("digital-core-office", Context.MODE_PRIVATE).getString("server-url", ""));
        }
    }

    @Test public void invalidHostNeverOpensLoginOrPersists() {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            for (String invalid : new String[]{"http://review.example.test", "https://review.example.test/time", "https://user@review.example.test", "review.example.test:65536"}) {
                onView(withId(R.id.server_address_input)).perform(scrollTo(), replaceText(invalid), closeSoftKeyboard());
                onView(withId(R.id.connect_server)).perform(scrollTo(), click());
                onView(withText(R.string.invalid_server)).check(matches(isDisplayed()));
                scenario.onActivity(activity -> assertTrue(findWebView(activity.findViewById(android.R.id.content)) == null));
                assertEquals("", ApplicationProvider.getApplicationContext().getSharedPreferences("digital-core-office", Context.MODE_PRIVATE).getString("server-url", ""));
            }
        }
    }

    @Test public void draftSurvivesActivityRecreation() {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            onView(withId(R.id.server_address_input)).perform(scrollTo(), replaceText("workplace.department.example.org:8443"), closeSoftKeyboard());
            scenario.recreate();
            onView(withId(R.id.server_address_input)).check(matches(withText("workplace.department.example.org:8443")));
        }
    }

    @Test public void directServerSwitchClearsCookiesAndSavedHost() throws Exception {
        Context context = ApplicationProvider.getApplicationContext();
        context.getSharedPreferences("digital-core-office",Context.MODE_PRIVATE).edit().putString("server-url","https://unreachable.invalid").commit();
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            CountDownLatch cookieSet = new CountDownLatch(1);
            scenario.onActivity(activity -> CookieManager.getInstance().setCookie("https://unreachable.invalid", "test-session=private; Secure", value -> cookieSet.countDown()));
            assertTrue(cookieSet.await(3, TimeUnit.SECONDS));
            LiveServerTest.awaitRecovery(scenario);
            onView(withId(R.id.recovery_change_server)).perform(click());
            onView(withText(R.string.change)).inRoot(isDialog()).perform(click());
            onView(withText(R.string.setup_title)).check(matches(isDisplayed()));
            assertEquals("", context.getSharedPreferences("digital-core-office",Context.MODE_PRIVATE).getString("server-url", ""));
            scenario.onActivity(activity -> assertTrue(CookieManager.getInstance().getCookie("https://unreachable.invalid") == null));
            scenario.recreate();
            onView(withId(R.id.server_address_input)).check(matches(withText("")));
        }
    }

    @Test public void applicationDoesNotRequestCameraPermission() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        PackageInfo info = context.getPackageManager().getPackageInfo(context.getPackageName(), PackageManager.GET_PERMISSIONS);
        assertFalse(info.requestedPermissions != null && Arrays.asList(info.requestedPermissions).contains(Manifest.permission.CAMERA));
    }

    @Test public void serverCanBeChangedWithoutLoadingTheWebsite() throws Exception {
        Context context = ApplicationProvider.getApplicationContext();
        context.getSharedPreferences("digital-core-office",Context.MODE_PRIVATE).edit().putString("server-url","https://unreachable.invalid").commit();
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            LiveServerTest.awaitRecovery(scenario);
            onView(withId(R.id.recovery_change_server)).check(matches(isDisplayed())).perform(click());
            onView(withText(R.string.change)).inRoot(isDialog()).perform(click());
            onView(withText(R.string.setup_title)).check(matches(isDisplayed()));
        }
    }

    @Test public void browserBlobDownloadIsSavedThroughTheNativeDocumentPicker() throws Exception {
        Context context = ApplicationProvider.getApplicationContext();
        context.getSharedPreferences("digital-core-office",Context.MODE_PRIVATE).edit().putString("server-url","https://export-test.invalid").commit();
        File destination = new File(context.getCacheDir(),"instrumented-export.csv");
        if (destination.exists()) destination.delete();
        Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        IntentFilter exportFilter = new IntentFilter(Intent.ACTION_CREATE_DOCUMENT);
        exportFilter.addCategory(Intent.CATEGORY_OPENABLE); exportFilter.addDataType("*/*");
        Instrumentation.ActivityMonitor picker = instrumentation.addMonitor(exportFilter,new Instrumentation.ActivityResult(Activity.RESULT_OK,new Intent().setData(Uri.fromFile(destination))),true);
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            scenario.onActivity(activity -> {
                WebView view = findWebView(activity.findViewById(android.R.id.content));
                view.stopLoading();
                view.loadDataWithBaseURL("https://export-test.invalid/","<html><body>Export acceptance test</body></html>","text/html","UTF-8",null);
            });
            boolean installed = false;
            for (int attempt = 0; attempt < 60 && !installed; attempt++) {
                CountDownLatch result = new CountDownLatch(1); AtomicBoolean ready = new AtomicBoolean(false);
                scenario.onActivity(activity -> findWebView(activity.findViewById(android.R.id.content)).evaluateJavascript("Boolean(window.DcoNativeDownloads) && Boolean(document.body && document.body.textContent.includes('Export acceptance test'))",value->{ready.set("true".equals(value));result.countDown();}));
                assertTrue(result.await(2,TimeUnit.SECONDS)); installed = ready.get();
                if (!installed) Thread.sleep(100);
            }
            assertTrue("The origin-restricted download bridge is installed",installed);
            scenario.onActivity(activity -> findWebView(activity.findViewById(android.R.id.content)).evaluateJavascript("(()=>{window.alert=message=>window.__exportError=message;const url=URL.createObjectURL(new Blob(['Name;Quantity\\r\\nMünchen;42\\r\\n'],{type:'text/csv'}));const a=document.createElement('a');a.href=url;a.download='inventory.csv';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),500);})()",null));
            for (int attempt=0;attempt<100 && (!destination.exists() || destination.length()==0);attempt++) Thread.sleep(100);
            CountDownLatch captured = new CountDownLatch(1); StringBuilder exportError = new StringBuilder();
            scenario.onActivity(activity -> findWebView(activity.findViewById(android.R.id.content)).evaluateJavascript("window.__exportError || 'No JavaScript error'",value->{exportError.append(value);captured.countDown();}));
            assertTrue(captured.await(2,TimeUnit.SECONDS));
            assertTrue("Native document picker was requested: " + exportError,picker.getHits()>0);
            assertEquals("Name;Quantity\r\nMünchen;42\r\n",new String(Files.readAllBytes(destination.toPath()),StandardCharsets.UTF_8));
        } finally {instrumentation.removeMonitor(picker);destination.delete();}
    }

    private static WebView findWebView(View view) {
        if (view instanceof WebView) return (WebView)view;
        if (view instanceof ViewGroup) {
            ViewGroup group=(ViewGroup)view;
            for(int index=0;index<group.getChildCount();index++){WebView result=findWebView(group.getChildAt(index));if(result!=null)return result;}
        }
        return null;
    }
}
