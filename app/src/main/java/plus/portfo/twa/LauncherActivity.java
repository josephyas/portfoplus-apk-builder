/*
 * Copyright 2020 Google Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * ---------------------------------------------------------------------------
 * CUSTOMIZED — this file is installed by twa-customizations/apply.mjs.
 * Do NOT edit app/src/main/java/... in place: Bubblewrap regenerates it.
 * Edit the copy under twa-customizations/files/ instead.
 * ---------------------------------------------------------------------------
 */
package plus.portfo.twa;

import android.content.pm.ActivityInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.TextUtils;
import android.util.Log;

import java.util.concurrent.atomic.AtomicBoolean;

import io.adtrace.sdk.AdTrace;

/**
 * TWA launcher that hands the device's Google Advertising ID to the web layer.
 *
 * A Trusted Web Activity has no live native/web channel, so the launch URL is
 * the only way to pass a device id in. We read the GAID from Play Services
 * before opening the TWA and append it as {@code ?gps_adid=...}; the AdTrace Web
 * SDK inside the PWA picks it up and feeds it to initSdk, which is what makes
 * the install attributable.
 */
public class LauncherActivity
        extends com.google.androidbrowserhelper.trusted.LauncherActivity {

    private static final String TAG = "PortfoLauncher";

    /** Query parameter consumed by the AdTrace Web SDK inside the PWA. */
    private static final String GPS_ADID_PARAM = "gps_adid";

    /** Play Services returns this when the user has opted out of ad personalisation. */
    private static final String GPS_ADID_OPT_OUT = "00000000-0000-0000-0000-000000000000";

    /**
     * Hard ceiling on how long the launch is held waiting for Play Services.
     *
     * This app ships through Cafe Bazaar, where a large share of devices have no
     * Google Play Services at all. Normally that fails fast (we catch it and
     * launch immediately), but a wedged Play Services install can leave the
     * callback pending forever. Nothing is drawn until launchTwa() runs — the
     * launcher theme is translucent — so this timeout is also the worst-case
     * blank screen the user sees. Keep it short; a real lookup resolves in well
     * under 300ms.
     */
    private static final long GAID_TIMEOUT_MS = 1000L;

    /** Ensures exactly one of {callback, timeout, exception} wins the race. */
    private final AtomicBoolean mLaunched = new AtomicBoolean(false);

    private final Handler mHandler = new Handler(Looper.getMainLooper());

    /** Written on the callback thread, read on the UI thread; hop is via mHandler. */
    private volatile String mGoogleAdId;

    private Runnable mTimeoutRunnable;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Setting an orientation crashes the app due to the transparent background on Android 8.0
        // Oreo and below. We only set the orientation on Oreo and above. This only affects the
        // splash screen and Chrome will still respect the orientation.
        // See https://github.com/GoogleChromeLabs/bubblewrap/issues/496 for details.
        if (Build.VERSION.SDK_INT > Build.VERSION_CODES.O) {
            setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_USER_PORTRAIT);
        } else {
            setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
        }

        // super.onCreate() finishes the Activity in several cases (share-intent
        // handling, restartInNewTask, a restored browser-was-launched flag)
        // before it would ever reach shouldLaunchImmediately(). Don't start a
        // timer against a dying Activity.
        if (isFinishing()) {
            return;
        }

        mTimeoutRunnable = new Runnable() {
            @Override
            public void run() {
                Log.w(TAG, "GAID lookup timed out after " + GAID_TIMEOUT_MS
                        + "ms; launching without " + GPS_ADID_PARAM);
                launchOnce("timeout");
            }
        };
        mHandler.postDelayed(mTimeoutRunnable, GAID_TIMEOUT_MS);

        try {
            AdTrace.getGoogleAdId(this, googleAdId -> {
                // Not guaranteed to be the main thread. Marshal, then launch.
                mHandler.post(() -> {
                    mGoogleAdId = googleAdId;
                    Log.d(TAG, "GAID resolved: "
                            + (TextUtils.isEmpty(googleAdId) ? "<empty>" : "<present>"));
                    launchOnce("callback");
                });
            });
        } catch (Throwable t) {
            // No Play Services on the device, or the SDK blew up. A missing
            // advertising id must never cost the user the app — this catches
            // Throwable because the failure mode is NoClassDefFoundError.
            Log.w(TAG, "AdTrace.getGoogleAdId threw; launching immediately", t);
            launchOnce("exception");
        }
    }

    /**
     * Hold the launch until the advertising id is in hand.
     *
     * Verified against androidbrowserhelper 2.6.2: the base onCreate() calls
     * launchTwa() from exactly one site, gated on this method, and it fully
     * initialises its metadata and splash-screen strategy beforehand. Nothing
     * else in the base class calls launchTwa(), so returning false here means
     * this class owns the launch entirely.
     */
    @Override
    protected boolean shouldLaunchImmediately() {
        return false;
    }

    /** Idempotent, main-thread only. Whoever gets here first wins. */
    private void launchOnce(String reason) {
        if (!mLaunched.compareAndSet(false, true)) {
            return;
        }
        mHandler.removeCallbacks(mTimeoutRunnable);
        if (isFinishing() || isDestroyed()) {
            Log.d(TAG, "Skipping launch (" + reason + "): activity is going away");
            return;
        }
        Log.d(TAG, "Launching TWA (" + reason + ")");
        launchTwa();
    }

    @Override
    protected Uri getLaunchingUrl() {
        // Start from super's result, never from a hardcoded base URL. In ABH
        // 2.6.2 this returns the incoming intent's data verbatim for https deep
        // links and only falls back to the manifest DEFAULT_URL otherwise —
        // rebuilding the URL from scratch (as the AdTrace sample does) would
        // silently break every deep link from the autoVerify VIEW filter.
        Uri uri = super.getLaunchingUrl();
        if (uri == null) {
            return null;
        }

        String adid = mGoogleAdId;
        if (TextUtils.isEmpty(adid)) {
            return uri;
        }
        if (GPS_ADID_OPT_OUT.equals(adid)) {
            Log.d(TAG, "GAID is the all-zeros opt-out id; not appending");
            return uri;
        }
        // Opaque URIs (mailto:-style) have no query component to append to, and
        // getQueryParameter() throws on them.
        if (uri.isOpaque()) {
            return uri;
        }
        if (!TextUtils.isEmpty(uri.getQueryParameter(GPS_ADID_PARAM))) {
            Log.d(TAG, GPS_ADID_PARAM + " already present; leaving URL untouched");
            return uri;
        }

        Log.d(TAG, "Appended " + GPS_ADID_PARAM + " to launch URL");
        return uri.buildUpon()
                .appendQueryParameter(GPS_ADID_PARAM, adid)
                .build();
    }

    @Override
    protected void onDestroy() {
        if (mTimeoutRunnable != null) {
            mHandler.removeCallbacks(mTimeoutRunnable);
        }
        super.onDestroy();
    }
}
