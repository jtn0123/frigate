package com.jtn.frigateviewer.ui

import android.content.Context
import androidx.test.core.app.ApplicationProvider

/** This text in the app's English, as a screen shows it; needs Robolectric. */
fun UiText.english(): String = resolve(ApplicationProvider.getApplicationContext<Context>().resources)
