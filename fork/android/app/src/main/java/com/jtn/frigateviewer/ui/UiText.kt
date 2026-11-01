package com.jtn.frigateviewer.ui

import android.content.res.Resources
import androidx.annotation.PluralsRes
import androidx.annotation.StringRes
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.ui.platform.LocalResources

/**
 * User-facing text worked out away from a screen, such as a failure, a notice
 * from a store or a widget's status. It holds a resource id and its arguments
 * rather than the words, so code without a Context can make it, tests can
 * compare it, and it is put into words with [resolve] where it is shown, in the
 * phone's language at that moment.
 */
@Immutable
sealed interface UiText {
    fun resolve(res: Resources): String

    /** Text that is already final, such as a reason the server gave. */
    data class Plain(val text: String) : UiText {
        override fun resolve(res: Resources): String = text
    }

    /** String resource [id] with [args], which may be [UiText] themselves. */
    data class Res(@param:StringRes val id: Int, val args: List<Any> = emptyList()) : UiText {
        override fun resolve(res: Resources): String = if (args.isEmpty()) res.getString(id) else res.getString(id, *resolved(args, res))
    }

    /** Plurals resource [id] for [count], with [args] (by default the count itself). */
    data class Plural(@param:PluralsRes val id: Int, val count: Int, val args: List<Any> = listOf(count)) : UiText {
        override fun resolve(res: Resources): String = res.getQuantityString(id, count, *resolved(args, res))
    }
}

/** String resource [id] with [args] as [UiText]. */
fun uiText(@StringRes id: Int, vararg args: Any): UiText = UiText.Res(id, args.toList())

/** Plurals resource [id] for [count] as [UiText], with [count] as its only argument. */
fun uiPlural(@PluralsRes id: Int, count: Int): UiText = UiText.Plural(id, count)

/** This text in words, in a composable. */
@Composable
@ReadOnlyComposable
fun UiText.resolve(): String = resolve(LocalResources.current)

private fun resolved(args: List<Any>, res: Resources): Array<Any> = Array(args.size) { i ->
    when (val arg = args[i]) {
        is UiText -> arg.resolve(res)
        else -> arg
    }
}
