package com.jtn.frigateviewer.ui

import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** The trust prompt shows the fingerprint and reports the user's choice. */
@RunWith(RobolectricTestRunner::class)
class CertificateDialogTest {
    @get:Rule val compose = createComposeRule()

    private val fingerprint = "AB:CD:EF:01:23:45"

    private fun pending(changed: Boolean) = PendingCertificate(
        fingerprint,
        changed,
        url = "https://nvr.lan:8971",
        user = "admin",
        password = "secret",
    )

    @Test
    fun aNewCertificateShowsItsFingerprintAndCanBeTrusted() {
        var trusted = 0
        compose.setContent { CertificateDialog(pending(changed = false), onTrust = { trusted++ }, onCancel = {}) }

        compose.onNodeWithText("Trust this certificate?").assertExists()
        compose.onNodeWithText(fingerprint).assertExists()
        compose.onNodeWithText("Trust").performClick()

        assertEquals(1, trusted)
    }

    @Test
    fun aChangedCertificateSaysSoAndCanBeCancelled() {
        var cancelled = 0
        compose.setContent { CertificateDialog(pending(changed = true), onTrust = {}, onCancel = { cancelled++ }) }

        compose.onNodeWithText("Certificate changed").assertExists()
        compose.onNodeWithText("Cancel").performClick()

        assertEquals(1, cancelled)
    }
}
