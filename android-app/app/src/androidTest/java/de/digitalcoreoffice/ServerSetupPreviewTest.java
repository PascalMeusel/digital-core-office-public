package de.digitalcoreoffice;

import static androidx.test.espresso.Espresso.onView;
import static androidx.test.espresso.action.ViewActions.*;
import static androidx.test.espresso.assertion.ViewAssertions.matches;
import static androidx.test.espresso.matcher.ViewMatchers.*;
import static org.junit.Assume.assumeTrue;

import android.content.Context;
import androidx.appcompat.app.AppCompatDelegate;
import androidx.core.os.LocaleListCompat;
import androidx.test.core.app.ActivityScenario;
import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class ServerSetupPreviewTest {
    @Test public void previewFormAndOfflineRecovery() throws Exception {
        String locale = InstrumentationRegistry.getArguments().getString("dcoPreviewLocale", "");
        assumeTrue("Opt-in screenshot and responsive check", !locale.isBlank());
        boolean dark = "true".equals(InstrumentationRegistry.getArguments().getString("dcoPreviewDark"));
        String prefix = "preview-" + locale + (dark ? "-dark" : "-light");
        Context context = ApplicationProvider.getApplicationContext();
        context.getSharedPreferences("digital-core-office", Context.MODE_PRIVATE).edit().clear().commit();
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
            if (android.os.Build.VERSION.SDK_INT >= 33) context.getSystemService(android.app.LocaleManager.class).setApplicationLocales(android.os.LocaleList.forLanguageTags(locale));
            else AppCompatDelegate.setApplicationLocales(LocaleListCompat.forLanguageTags(locale));
            AppCompatDelegate.setDefaultNightMode(dark ? AppCompatDelegate.MODE_NIGHT_YES : AppCompatDelegate.MODE_NIGHT_NO);
        });
        try {
            try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
                scenario.onActivity(activity -> org.junit.Assert.assertEquals(locale, activity.getResources().getConfiguration().getLocales().get(0).getLanguage()));
                onView(withId(R.id.connect_server)).perform(scrollTo()).check(matches(isDisplayed()));
                LiveServerTest.capture(context, prefix + "-setup");
                onView(withId(R.id.server_address_input)).perform(scrollTo(), replaceText("http://workplace.example.org"), closeSoftKeyboard());
                onView(withId(R.id.connect_server)).perform(scrollTo(), click());
                onView(withText(R.string.invalid_server)).check(matches(isDisplayed()));
                onView(withId(R.id.connect_server)).perform(scrollTo()).check(matches(isDisplayed()));
                LiveServerTest.capture(context, prefix + "-error");
            }
            context.getSharedPreferences("digital-core-office",Context.MODE_PRIVATE).edit().putString("server-url","https://a-very-long-workplace-name.department.regional-office.example.invalid:8443").commit();
            try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
                LiveServerTest.awaitRecovery(scenario);
                onView(withText(R.string.change)).check(matches(isDisplayed()));
                LiveServerTest.capture(context, prefix + "-offline");
            }
        } finally {
            context.getSharedPreferences("digital-core-office",Context.MODE_PRIVATE).edit().clear().commit();
            InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
                if (android.os.Build.VERSION.SDK_INT >= 33) context.getSystemService(android.app.LocaleManager.class).setApplicationLocales(android.os.LocaleList.getEmptyLocaleList());
                else AppCompatDelegate.setApplicationLocales(LocaleListCompat.getEmptyLocaleList());
                AppCompatDelegate.setDefaultNightMode(AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM);
            });
        }
    }
}
