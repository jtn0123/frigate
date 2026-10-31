package com.jtn.frigateviewer.data

import javax.crypto.KeyGenerator
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TokenCipherTest {
    private fun newKey() = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
    private val key = newKey()
    private val cipher = TokenCipher { key }
    private val token = "eyJhbGciOiJIUzI1NiJ9.payload.signature"

    @Test
    fun roundTripsWithoutStoringTheToken() {
        val stored = cipher.encrypt(token)
        assertFalse(stored.contains("payload"))
        assertNotEquals("A fresh IV each time", stored, cipher.encrypt(token))
        assertEquals(token, cipher.decrypt(stored))
    }

    @Test
    fun aTokenSavedBeforeEncryptionStillReads() {
        assertEquals(token, cipher.decrypt(token))
        assertFalse(cipher.isEncrypted(token))
        assertTrue(cipher.isEncrypted(cipher.encrypt(token)))
        assertEquals("", cipher.encrypt(""))
    }

    @Test
    fun anotherKeyOrDamagedDataReadsAsNoToken() {
        val stored = cipher.encrypt(token)
        assertNull(TokenCipher { newKey() }.decrypt(stored))
        assertNull(cipher.decrypt(stored.dropLast(4) + "AAAA"))
        assertNull(cipher.decrypt("v1:not base64!"))
    }
}
