package com.jtn.frigateviewer.data

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.GeneralSecurityException
import java.security.KeyStore
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Encrypts the saved JWT with AES-GCM, so a copy of the app's files alone
 * does not give a working session. On a phone the key stays in the Android
 * Keystore ([androidKeystore]).
 */
class TokenCipher(private val key: () -> SecretKey) {
    fun encrypt(token: String): String {
        if (token.isEmpty()) return ""
        val cipher = Cipher.getInstance(TRANSFORMATION).apply { init(Cipher.ENCRYPT_MODE, key()) }
        return PREFIX + Base64.getEncoder().encodeToString(cipher.iv + cipher.doFinal(token.toByteArray()))
    }

    fun isEncrypted(stored: String): Boolean = stored.startsWith(PREFIX)

    /**
     * The token, or null when it cannot be decrypted (the key is gone, as after
     * a restore to another phone). A token saved before encryption is returned
     * as it is and encrypted on the next save.
     */
    fun decrypt(stored: String): String? {
        if (!isEncrypted(stored)) return stored
        return try {
            val bytes = Base64.getDecoder().decode(stored.removePrefix(PREFIX))
            val cipher = Cipher.getInstance(TRANSFORMATION).apply {
                init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(TAG_BITS, bytes, 0, IV_BYTES))
            }
            String(cipher.doFinal(bytes, IV_BYTES, bytes.size - IV_BYTES))
        } catch (_: GeneralSecurityException) {
            null
        } catch (_: IllegalArgumentException) {
            null
        }
    }

    companion object {
        private const val PREFIX = "v1:"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val IV_BYTES = 12
        private const val TAG_BITS = 128
        private const val KEY_ALIAS = "frigate_token"
        private const val KEY_BITS = 256

        /** A cipher whose key is created in, and never leaves, the Android Keystore. */
        fun androidKeystore() = TokenCipher {
            val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            (keyStore.getKey(KEY_ALIAS, null) as? SecretKey) ?: KeyGenerator
                .getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
                .apply {
                    init(
                        KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                            .setKeySize(KEY_BITS)
                            .build(),
                    )
                }
                .generateKey()
        }
    }
}
