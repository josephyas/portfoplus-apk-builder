# Installed by twa-customizations/apply.mjs — edit the copy under
# twa-customizations/files/, not this one. Bubblewrap does not generate this
# file, but `minifyEnabled true` is on for release, so without these keeps R8
# strips the advertising-id lookup and gps_adid silently stops being appended
# in release builds only.

# AdTrace SDK
-keep class io.adtrace.sdk.** { *; }
-keep interface io.adtrace.sdk.** { *; }
-keep enum io.adtrace.sdk.** { *; }

# Google Play Services — advertising id. Reached reflectively.
-keep class com.google.android.gms.common.ConnectionResult {
    int SUCCESS;
}
-keep class com.google.android.gms.ads.identifier.AdvertisingIdClient {
    com.google.android.gms.ads.identifier.AdvertisingIdClient$Info getAdvertisingIdInfo(android.content.Context);
}
-keep class com.google.android.gms.ads.identifier.AdvertisingIdClient$Info {
    java.lang.String getId();
    boolean isLimitAdTrackingEnabled();
}

# Entry points referenced only from AndroidManifest.xml, by short name.
-keep class plus.portfo.twa.LauncherActivity { *; }
-keep class plus.portfo.twa.Application { *; }
-keep class plus.portfo.twa.DelegationService { *; }
