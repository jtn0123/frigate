package com.jtn.frigateviewer.ui

import android.app.Activity
import android.view.WindowManager
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** With the app lock on, Recents shows no camera frames. */
@RunWith(RobolectricTestRunner::class)
class RecentsTest {
    private fun secure(activity: Activity) = activity.window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE != 0

    @Test
    @Config(sdk = [32])
    fun beforeAndroid13TheWindowIsSecureWhileLocked() {
        Robolectric.buildActivity(Activity::class.java).setup().use { controller ->
            val activity = controller.get()
            activity.hideFromRecents(true)
            assertEquals(true, secure(activity))
            activity.hideFromRecents(false)
            assertEquals(false, secure(activity))
        }
    }

    @Test
    @Config(sdk = [34])
    fun fromAndroid13RecentsGetsABlankCardAndScreenshotsStayAllowed() {
        Robolectric.buildActivity(Activity::class.java).setup().use { controller ->
            val activity = controller.get()
            activity.hideFromRecents(true)
            assertEquals(false, secure(activity))
        }
    }
}
