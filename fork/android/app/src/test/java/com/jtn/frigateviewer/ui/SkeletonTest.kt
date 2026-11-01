package com.jtn.frigateviewer.ui

import androidx.compose.material3.Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import com.jtn.frigateviewer.data.Remote
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** The first load shows the shapes of what is coming, then the content in their place. */
@RunWith(RobolectricTestRunner::class)
class SkeletonTest {
    @get:Rule val compose = createComposeRule()

    @Test
    fun theSkeletonGivesWayToTheContent() {
        var state by mutableStateOf<Remote<String>>(Remote.Loading)
        compose.setContent {
            RemoteContent(state, onRetry = {}, placeholder = { ReviewListSkeleton() }) { Text(it) }
        }
        compose.onNodeWithContentDescription("Loading").assertExists()

        state = Remote.Ready("Front door")
        compose.onNodeWithText("Front door").assertExists()
        compose.onNodeWithContentDescription("Loading").assertDoesNotExist()
    }

    @Test
    fun theCameraGridHasASkeletonToo() {
        compose.setContent {
            RemoteContent(Remote.Loading, onRetry = {}, placeholder = { CameraGridSkeleton(columns = 2) }) { }
        }
        compose.onNodeWithContentDescription("Loading").assertExists()
    }
}
