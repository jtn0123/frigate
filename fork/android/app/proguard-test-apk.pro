# Rules for the device tests' own APK, which R8 shrinks too when the build they
# test is minified. The test libraries name Error Prone's annotations, which are
# only read by its compile-time checker and so ship in no APK.
-dontwarn com.google.errorprone.annotations.**
