# kotlinx.serialization keeps its generated serializers via its own consumer
# rules, and WireGuard's GoBackend keeps its native methods, which its JNI
# library binds by name, through the default proguard-android-optimize.txt rule
# for native methods (its AAR ships no rules of its own). Nothing app-specific is
# needed yet; the minified device run (Fork - Android device tests) shows when it is.
