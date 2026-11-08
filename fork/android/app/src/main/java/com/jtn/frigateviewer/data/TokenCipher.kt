package com.jtn.frigateviewer.data

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.GeneralSecurityException
import java.security.KeyStore
import java.security.ProviderException
import java.util.Base64
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Encrypts the saved JWT with AES-GCM, so a copy of the app's files alone
 * does not give a working session. On a phone the key stays in the Android
 * Keystore ([androidKeystore]).
 *
 * The key is looked up, or made, once and kept, rather than on every read of
 * the settings. A Keystore that fails, as some phones' do after an update or
 * while locked, reads and saves as signed out instead of crashing, and the
 * key is looked up again next time.
 */
class TokenCipher(private val loadKey: () -> SecretKey) {
    @Volatile private var cached: SecretKey? = null
    private val lock = Any()

    /** The key, from [loadKey] the first time only; two callers at once still load it once. */
    private fun key(): SecretKey = cached ?: synchronized(lock) { cached ?: loadKey().also { cached = it } }

    /** [token] encrypted, or "" (signed out) when the Keystore cannot encrypt it. */
    fun encrypt(token: String): String {
        if (token.isEmpty()) return ""
        return keystore(fallback = "") {
            val cipher = Cipher.getInstance(TRANSFORMATION).apply { init(Cipher.ENCRYPT_MODE, key()) }
            PREFIX + Base64.getEncoder().encodeToString(cipher.iv + cipher.doFinal(token.toByteArray()))
        }
    }

    fun isEncrypted(stored: String): Boolean = stored.startsWith(PREFIX)

    /**
     * The token, or null when it cannot be decrypted (the key is gone, as after
     * a restore to another phone, or the Keystore fails). A token saved before
     * encryption is returned as it is and encrypted on the next save.
     */
    fun decrypt(stored: String): String? {
        if (!isEncrypted(stored)) return stored
        // Not Base64, or too short to hold the IV: damaged, so no token.
        val bytes = runCatching { Base64.getDecoder().decode(stored.removePrefix(PREFIX)) }.getOrNull()
        if (bytes == null || bytes.size <= IV_BYTES) return null
        return keystore(fallback = null) {
            val cipher = Cipher.getInstance(TRANSFORMATION).apply {
                init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(TAG_BITS, bytes, 0, IV_BYTES))
            }
            String(cipher.doFinal(bytes, IV_BYTES, bytes.size - IV_BYTES))
        }
    }

    /**
     * Runs [block], giving [fallback] if the key or the cipher fails. Data the
     * key does not open says nothing about the key; any other failure drops it,
     * so the next call looks it up again.
     */
    private inline fun <T> keystore(fallback: T, block: () -> T): T = try {
        block()
    } catch (_: AEADBadTagException) {
        fallback
    } catch (_: GeneralSecurityException) {
        fallback.also { cached = null }
    } catch (_: ProviderException) {
        fallback.also { cached = null }
    } catch (_: IllegalStateException) {
        fallback.also { cached = null }
    }

    companion object {
        private const val PREFIX = "v1:"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val IV_BYTES = 12
        private const val TAG_BITS = 128
        private const val KEY_ALIAS = "frigate_token"
        private const val KEY_BITS = 256

        /** Across ciphers too, so the key is never made twice, each replacing the other's. */
        private val keystoreLock = Any()

        /** A cipher whose key is created in, and never leaves, the Android Keystore. */
        fun androidKeystore() = TokenCipher { synchronized(keystoreLock) { keystoreKey() } }

        private fun keystoreKey(): SecretKey {
            val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            return (keyStore.getKey(KEY_ALIAS, null) as? SecretKey) ?: KeyGenerator
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
