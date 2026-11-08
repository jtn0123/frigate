package com.jtn.frigateviewer.tunnel

import com.wireguard.crypto.KeyPair
import java.util.Base64
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * What the tunnel log and its report hide: WireGuard keys, and every address
 * cut to its kind and last part, while text that only looks like either stays.
 */
class RedactTest {
    private val keys = KeyPair()

    @Test
    fun aKeyIsHiddenWhereverItSits() {
        val private = keys.privateKey.toBase64()
        val public = keys.publicKey.toBase64()

        assertEquals("PrivateKey = (key hidden)", redact("PrivateKey = $private"))
        assertEquals("peer (key hidden) answered", redact("peer $public answered"))
        assertEquals("key=(key hidden), \"(key hidden)\"", redact("key=$private, \"$public\""))
    }

    @Test
    fun base64ThatIsNotAKeyStays() {
        // 64 bytes, as a signature might be: longer than a key, so not one.
        val long = Base64.getEncoder().encodeToString(ByteArray(64) { it.toByte() })
        assertEquals(long, redact(long))
        // A key's length but the wrong last character: it cannot be 32 bytes.
        val notAKey = "B".repeat(43) + "="
        assertEquals(notAKey, redact(notAKey))
    }

    @Test
    fun redactHidesKeysAndAddressesTogether() {
        val key = keys.publicKey.toBase64()
        assertEquals(
            "handshake with (key hidden) at public …4:51820 from private IPv6 …2",
            redact("handshake with $key at 198.51.100.4:51820 from fd00::2"),
        )
    }

    @Test
    fun eachKindOfIpv4AddressIsNamed() {
        assertEquals("private …3", maskAddresses("10.1.2.3"))
        assertEquals("private …9", maskAddresses("172.16.0.9"))
        assertEquals("private …20", maskAddresses("192.168.1.20"))
        assertEquals("carrier-NAT …1", maskAddresses("100.64.0.1"))
        assertEquals("carrier-NAT …254", maskAddresses("100.127.255.254"))
        assertEquals("loopback …1", maskAddresses("127.0.0.1"))
        assertEquals("link-local …11", maskAddresses("169.254.10.11"))
        assertEquals("any …0", maskAddresses("0.0.0.0"))
        assertEquals("public …8", maskAddresses("8.8.8.8"))
    }

    @Test
    fun theEdgesOfEachRangeAreRight() {
        // 172.16.0.0/12 ends at 172.31, and 100.64.0.0/10 at 100.127.
        assertEquals("private …1", maskAddresses("172.31.255.1"))
        assertEquals("public …1", maskAddresses("172.32.0.1"))
        assertEquals("public …1", maskAddresses("100.128.0.1"))
        assertEquals("public …1", maskAddresses("100.63.255.1"))
    }

    @Test
    fun aPortOrPrefixAfterAnAddressStays() {
        assertEquals("public …4:51820", maskAddresses("203.0.113.4:51820"))
        assertEquals("Address = private …2/32", maskAddresses("Address = 192.168.2.2/32"))
        assertEquals("from private …1, then public …8.", maskAddresses("from 10.0.0.1, then 8.8.4.8."))
    }

    @Test
    fun numbersThatAreNotIpv4AddressesStay() {
        assertEquals("256.1.1.1", maskAddresses("256.1.1.1"))
        assertEquals("App 0.2.3 (debug), Android 16 (API 36)", maskAddresses("App 0.2.3 (debug), Android 16 (API 36)"))
        assertEquals("sent 1.5 MB in 12.25 s", maskAddresses("sent 1.5 MB in 12.25 s"))
    }

    @Test
    fun eachKindOfIpv6AddressIsNamed() {
        assertEquals("loopback IPv6 …1", maskAddresses("::1"))
        assertEquals("any IPv6 …0", maskAddresses("::"))
        assertEquals("private IPv6 …7", maskAddresses("fd12:3456::7"))
        assertEquals("private IPv6 …5", maskAddresses("fec0::5"))
        assertEquals("public IPv6 …0", maskAddresses("2001:db8::"))
        assertEquals("public IPv6 …0001", maskAddresses("2001:0db8:0000:0000:0000:0000:0000:0001"))
        assertEquals("public IPv6 …A", maskAddresses("2001:DB8::A"))
    }

    @Test
    fun colonsThatAreNotIpv6AddressesStay() {
        assertEquals("1:2:3", maskAddresses("1:2:3"))
        assertEquals("ratio 16:9", maskAddresses("ratio 16:9"))
        assertEquals("12:00:00 to 13:30:00", maskAddresses("12:00:00 to 13:30:00"))
    }

    @Test
    fun aHostIsCutToItsKindOrItsEnding() {
        assertEquals("public IPv6 …5", maskHost("[2001:db8::5]"))
        assertEquals("private …20", maskHost("192.168.1.20"))
        assertEquals("a hostname ending .org", maskHost("frigate.example.org"))
    }

    @Test
    fun describingAHostSaysWhetherTheInternetCanReachIt() {
        assertEquals("a private IPv4 address (…1), only reachable inside that network", describeHost("10.0.0.1"))
        assertEquals("a carrier-grade NAT address (…14), not reachable from the internet", describeHost("100.72.9.14"))
        assertEquals("a loopback address (…1)", describeHost("127.0.0.1"))
        assertEquals("a link-local IPv6 address (…1)", describeHost("fe80::1"))
        assertEquals("a hostname ending .lan", describeHost("nvr.home.lan"))
    }
}
