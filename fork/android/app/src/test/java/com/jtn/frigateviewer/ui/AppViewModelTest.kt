package com.jtn.frigateviewer.ui

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.viewModelScope
import com.jtn.frigateviewer.data.ReviewItem
import com.jtn.frigateviewer.data.ServerSettings
import com.jtn.frigateviewer.data.SettingsStore
import com.jtn.frigateviewer.data.certificateFingerprint
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.cancel
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.job
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import mockwebserver3.junit4.MockWebServerRule
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/** Sign-in, sign-out and navigation as the screens drive them, against a fake Frigate. */
@OptIn(ExperimentalCoroutinesApi::class)
class AppViewModelTest {
    @get:Rule val serverRule = MockWebServerRule()

    @get:Rule val temp = TemporaryFolder()
    private val server: MockWebServer get() = serverRule.server

    private val main = Executors.newSingleThreadExecutor().asCoroutineDispatcher()
    private val storeScope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private lateinit var file: File
    private lateinit var store: SettingsStore

    /** Paths requested, in order; read while the app is still making requests. */
    private val paths = CopyOnWriteArrayList<String>()

    /** Status per path, for the responses that should fail. */
    private val failing = mutableMapOf<String, Int>()

    private val item = ReviewItem(id = "r1", camera = "driveway", startTime = 1.0, endTime = 2.0, severity = "alert", thumbPath = "/t.webp")

    @Before
    fun setUp() {
        Dispatchers.setMain(main)
        file = File(temp.root, "server.preferences_pb")
        store = testSettingsStore(file, storeScope)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.url.encodedPath
                paths += path
                failing[path]?.let { return MockResponse.Builder().code(it).build() }
                return when (path) {
                    "/api/login" -> MockResponse.Builder().addHeader("Set-Cookie", "frigate_token=jwt1; Path=/").body("{}").build()
                    "/api/config" -> MockResponse.Builder().body("""{"cameras": {}}""").build()
                    "/api/review" -> MockResponse.Builder().body("[]").build()
                    "/api/version" -> MockResponse.Builder().body("0.17.0").build()
                    else -> MockResponse.Builder().code(200).body("{}").build()
                }
            }
        }
    }

    /** View models made by the test, whose work must stop before the main dispatcher goes. */
    private val viewModels = mutableListOf<AppViewModel>()

    @After
    fun tearDown() {
        runBlocking { viewModels.forEach { it.viewModelScope.coroutineContext.job.cancelAndJoin() } }
        Dispatchers.resetMain()
        main.close()
        storeScope.cancel()
    }

    private fun url() = server.url("/").toString()

    private fun viewModel(saved: SavedStateHandle = SavedStateHandle()) = AppViewModel(saved, store).also { vm ->
        viewModels += vm
        await("settings load") { vm.loaded }
    }

    /** Waits for the app's background work to reach [condition]. */
    private fun await(what: String, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 5_000
        while (!runOnMain(condition)) {
            check(System.currentTimeMillis() < deadline) { "Timed out waiting for $what" }
            Thread.sleep(10)
        }
    }

    private fun <T> runOnMain(block: () -> T): T = runBlocking(main) { block() }

    private fun signIn(vm: AppViewModel) {
        runOnMain { vm.login(url(), "admin", "secret", selfSignedCert = false) }
        await("session") { vm.session != null }
    }

    @Test
    fun signingInStartsASessionAndSavesTheTokenEncrypted() {
        val vm = viewModel()

        signIn(vm)

        assertEquals("jwt1", runBlocking { store.settings.first() }.token)
        assertTrue("Stored encrypted", file.readBytes().decodeToString().contains("v1:"))
        assertFalse("Not stored in plain text", file.readBytes().decodeToString().contains("jwt1"))
    }

    @Test
    fun aWrongPasswordSaysSo() {
        failing["/api/login"] = 401
        val vm = viewModel()

        runOnMain { vm.login(url(), "admin", "wrong", selfSignedCert = false) }
        await("login to finish") { !vm.loggingIn }

        assertEquals("Wrong username or password", runOnMain { vm.loginError })
        assertNull(runOnMain { vm.session })
    }

    @Test
    fun aPasswordIsNotSentOverHttpToAPublicAddress() {
        val vm = viewModel()

        runOnMain { vm.login("http://example.com:5000", "admin", "secret", selfSignedCert = false) }
        await("login to finish") { !vm.loggingIn }

        assertTrue(runOnMain { vm.loginError }.orEmpty().contains("not a local address"))
        assertTrue("Nothing reached a server", paths.isEmpty())
    }

    @Test
    fun aSelfSignedCertificateIsTrustedBeforeThePasswordIsSent() {
        val cert = HeldCertificate.Builder().addSubjectAlternativeName(server.hostName).build()
        server.useHttps(HandshakeCertificates.Builder().heldCertificate(cert).build().sslSocketFactory())
        val vm = viewModel()

        runOnMain { vm.login(url(), "admin", "secret", selfSignedCert = true) }
        await("trust prompt") { vm.pendingCertificate != null }

        val pending = runOnMain { vm.pendingCertificate }!!
        assertEquals(certificateFingerprint(cert.certificate), pending.fingerprint)
        assertFalse("The password stays out of logs", "secret" in pending.toString())
        assertFalse("No password before trust", "/api/login" in paths)

        runOnMain { vm.trustCertificate() }
        await("session") { vm.session != null }

        assertEquals(certificateFingerprint(cert.certificate), runBlocking { store.settings.first() }.certificatePin)
    }

    @Test
    fun signingOutClearsTheTokenAndOpenScreens() {
        val vm = viewModel()
        signIn(vm)
        runOnMain {
            vm.nav.tab = Tab.REVIEW
            vm.openEvent(item)
        }

        runOnMain { vm.logout() }
        await("sign-out") { vm.session == null }
        await("the server to end the session") { "/api/logout" in paths }

        assertEquals(emptyList<Overlay>(), runOnMain { vm.nav.overlays })
        assertEquals(Tab.CAMERAS, runOnMain { vm.nav.tab })
        assertEquals("", runBlocking { store.settings.first() }.token)
        assertEquals("The address is kept for signing in again", url(), runBlocking { store.settings.first() }.baseUrl)
    }

    @Test
    fun aChosenThemeIsSavedAndKeptThroughSigningOut() {
        val vm = viewModel()
        signIn(vm)

        runOnMain { vm.setTheme(AppTheme.EMBER) }
        await("theme saved") { runBlocking { store.settings.first() }.theme == "ember" }
        runOnMain { vm.logout() }
        await("sign-out") { vm.session == null }

        assertEquals(AppTheme.EMBER, runOnMain { vm.theme })
        val restarted = viewModel()
        assertEquals(AppTheme.EMBER, runOnMain { restarted.theme })
    }

    @Test
    fun theLockSettingIsSavedAndKeptThroughSigningOut() {
        val vm = viewModel()
        signIn(vm)

        runOnMain { vm.setAppLock(true) }
        await("lock saved") { runBlocking { store.settings.first() }.appLock }
        runOnMain { vm.logout() }
        await("sign-out") { vm.session == null }

        assertTrue(runOnMain { vm.appLock })
        val restarted = viewModel()
        assertTrue(runOnMain { restarted.appLock && restarted.lock.locked })
    }

    @Test
    fun backClosesTheTopScreenAndOlderNewerReplaceTheEvent() {
        val vm = viewModel()
        signIn(vm)
        val newer = item.copy(id = "r2")
        runOnMain {
            vm.nav.openCamera("driveway")
            vm.openEvent(item)
            vm.showEvent(newer)
        }

        assertEquals(listOf(Overlay.CameraDetail("driveway"), Overlay.Event("r2")), runOnMain { vm.nav.overlays })
        assertTrue(runOnMain { vm.nav.back() })
        assertEquals(listOf(Overlay.CameraDetail("driveway")), runOnMain { vm.nav.overlays })
        assertTrue(runOnMain { vm.nav.back() })
        assertFalse("Nothing left to close", runOnMain { vm.nav.back() })
    }

    @Test
    fun openScreensAreRestoredAfterAndroidStopsTheApp() {
        val saved = SavedStateHandle()
        val first = viewModel(saved)
        signIn(first)
        runOnMain {
            first.nav.tab = Tab.REVIEW
            first.openEvent(item)
        }

        val restored = viewModel(saved)

        assertEquals(Tab.REVIEW, runOnMain { restored.nav.tab })
        assertEquals(listOf(Overlay.Event("r1")), runOnMain { restored.nav.overlays })
    }

    @Test
    fun aRejectedTokenSignsOut() {
        runBlocking { store.save(ServerSettings(baseUrl = url(), username = "admin", token = "revoked")) }
        failing["/api/config"] = 401
        failing["/api/review"] = 401
        failing["/api/version"] = 401

        val vm = viewModel()
        await("sign-out") { vm.session == null && "/api/config" in paths }

        assertEquals("", runBlocking { store.settings.first() }.token)
        assertFalse("Nothing to revoke", "/api/logout" in paths)
        assertNotNull("Stays on the sign-in screen with the address", runOnMain { vm.savedSettings.baseUrl.ifEmpty { null } })
    }
}
