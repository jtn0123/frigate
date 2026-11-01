package com.jtn.frigateviewer

import androidx.test.ext.junit.runners.AndroidJUnit4
import com.jtn.frigateviewer.data.TokenCipher
import java.security.KeyStore
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/** The token's encryption with a key in the real Android Keystore, which the JVM tests replace with a plain key. */
@RunWith(AndroidJUnit4::class)
class TokenCipherDeviceTest {
    private val cipher = TokenCipher.androidKeystore()

    @Test
    fun aTokenEncryptedWithTheKeystoreKeyDecryptsBack() {
        val token = "a session token for the smoke test"
        val stored = cipher.encrypt(token)
        assertTrue(cipher.isEncrypted(stored))
        assertFalse(stored, token in stored)
        assertEquals(token, cipher.decrypt(stored))
        // A fresh IV each time: the same token is never stored the same way twice.
        assertFalse(stored == cipher.encrypt(token))
    }

    @Test
    fun theKeyStaysInTheKeystoreAndATamperedTokenIsRejected() {
        val stored = cipher.encrypt("token")
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        assertTrue(keyStore.containsAlias("frigate_token"))
        // A changed byte fails GCM's check, which reads as signed out rather than a crash.
        val last = stored.last()
        assertNull(cipher.decrypt(stored.dropLast(1) + if (last == 'A') 'B' else 'A'))
    }
}
