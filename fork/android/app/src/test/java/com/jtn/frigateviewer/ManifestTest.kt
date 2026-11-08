package com.jtn.frigateviewer

import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import androidx.test.core.app.ApplicationProvider
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** What the app's own manifest declares, rather than gets from a library's by chance. */
@RunWith(RobolectricTestRunner::class)
class ManifestTest {
    /** The permissions src/main/AndroidManifest.xml asks for itself; tests run in the app module. */
    private fun declared(): List<String> {
        val document = DocumentBuilderFactory.newInstance().apply { isNamespaceAware = true }
            .newDocumentBuilder()
            .parse(File("src/main/AndroidManifest.xml"))
        val uses = document.getElementsByTagName("uses-permission")
        return List(uses.length) { uses.item(it).attributes.getNamedItemNS(ANDROID, "name").nodeValue }
    }

    @Test
    fun theAppDeclaresWhatItUses() {
        val declared = declared()
        // tunnel/DirectRoute.kt reads the networks; until now only Media3's manifest asked for it.
        assertTrue(declared.toString(), "android.permission.ACCESS_NETWORK_STATE" in declared)
        // Saving a clip in the background (work/ClipWorker.kt).
        listOf(
            "android.permission.POST_NOTIFICATIONS",
            "android.permission.FOREGROUND_SERVICE",
            "android.permission.FOREGROUND_SERVICE_DATA_SYNC",
        ).forEach { assertTrue("$it in $declared", it in declared) }
    }

    @Test
    fun workManagersForegroundServiceIsADataSyncOne() {
        val context: Context = ApplicationProvider.getApplicationContext()
        val service = ComponentName(context, "androidx.work.impl.foreground.SystemForegroundService")
        val info = context.packageManager.getServiceInfo(service, PackageManager.GET_META_DATA)
        assertEquals(ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC, info.foregroundServiceType)
    }

    private companion object {
        const val ANDROID = "http://schemas.android.com/apk/res/android"
    }
}
