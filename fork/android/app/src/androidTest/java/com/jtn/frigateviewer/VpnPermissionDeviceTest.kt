package com.jtn.frigateviewer

import android.net.VpnService
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.jtn.frigateviewer.tunnel.WireGuardBackend
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Asking whether the app may open its VPN, on a real VpnService. Only asked:
 * the consent screen, which would turn another app's VPN off, is never shown.
 */
@RunWith(AndroidJUnit4::class)
class VpnPermissionDeviceTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    @Test
    fun askingForTheVpnPermissionDoesNotCrashAndAgreesWithAndroid() {
        // Null when allowed already, or the consent screen to show; either is fine here.
        val consent = VpnService.prepare(context)
        assertEquals(consent == null, WireGuardBackend(context).hasPermission())
    }
}
