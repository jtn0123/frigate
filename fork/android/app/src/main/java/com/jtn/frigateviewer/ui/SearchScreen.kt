package com.jtn.frigateviewer.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.SearchOff
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.DateRangePicker
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SelectableDates
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDateRangePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil3.ImageLoader
import coil3.compose.AsyncImage
import com.jtn.frigateviewer.data.Remote
import com.jtn.frigateviewer.data.SEARCH_LIMIT
import com.jtn.frigateviewer.data.Session
import com.jtn.frigateviewer.data.TrackedObject
import com.jtn.frigateviewer.data.objectThumbnailUrl
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZoneOffset

/** Review items from any day, by date, camera and label, and by description when the server can. */
@Composable
fun SearchScreen(vm: AppViewModel, session: Session, imageLoader: ImageLoader) {
    val search = vm.search
    val inputs = search.inputs
    LaunchedEffect(inputs) { search.run(session.api) }
    LaunchedEffect(Unit) { search.loadLabels(session.api) }
    val snackbar = remember { SnackbarHostState() }
    LaunchedEffect(search.notice) {
        search.notice?.let {
            snackbar.showSnackbar(it)
            search.noticeShown()
        }
    }

    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize().background(Palette.Chrome)) {
            DetailHeader("Search", onBack = { vm.nav.back() })
            if (vm.semanticSearch) DescriptionField(inputs.query) { search.inputs = inputs.copy(query = it) }
            SearchFilters(vm, search)
            TabSheet(Modifier.padding(top = 4.dp)) {
                RemoteContent(search.results, onRetry = { search.run(session.api, force = true) }) { hits ->
                    SearchResults(vm, session, imageLoader, hits)
                }
            }
        }
        SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter).padding(16.dp))
    }
}

@Composable
private fun DescriptionField(submitted: String, onSearch: (String) -> Unit) {
    var text by rememberSaveable { mutableStateOf(submitted) }
    OutlinedTextField(
        value = text,
        onValueChange = { text = it },
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
        placeholder = { Text("Describe it, like \"white van\"") },
        leadingIcon = { Icon(Icons.Outlined.Search, contentDescription = null) },
        trailingIcon = {
            if (text.isNotEmpty()) {
                IconButton(onClick = {
                    text = ""
                    onSearch("")
                }) { Icon(Icons.Outlined.Close, contentDescription = "Clear") }
            }
        },
        singleLine = true,
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
        keyboardActions = KeyboardActions(onSearch = { onSearch(text) }),
    )
}

@Composable
private fun SearchFilters(vm: AppViewModel, search: ReviewSearch) {
    val inputs = search.inputs
    var pickingDates by remember { mutableStateOf(false) }
    ChipRow(SearchRange.entries, selected = { it == inputs.range }, label = { range ->
        if (range == SearchRange.CUSTOM && inputs.from != null) dateSpan(inputs.from, inputs.to ?: inputs.from) else range.label
    }) { range ->
        if (range == SearchRange.CUSTOM) pickingDates = true else search.inputs = inputs.copy(range = range)
    }
    val cameras = (vm.cameras as? Remote.Ready)?.value.orEmpty()
    ChipRow(cameras, selected = { it.name in inputs.cameras }, label = { it.label }) { camera ->
        search.inputs = inputs.copy(cameras = inputs.cameras.toggle(camera.name))
    }
    if (search.labels.isNotEmpty()) {
        ChipRow(search.labels, selected = { it in inputs.labels }, label = { it.replaceFirstChar(Char::uppercase) }) { label ->
            search.inputs = inputs.copy(labels = inputs.labels.toggle(label))
        }
    }
    if (pickingDates) {
        DatesDialog(onDismiss = { pickingDates = false }) { from, to ->
            pickingDates = false
            search.inputs = inputs.copy(range = SearchRange.CUSTOM, from = from, to = to)
        }
    }
}

private fun <T> Set<T>.toggle(value: T): Set<T> = if (value in this) this - value else this + value

@Composable
private fun <T> ChipRow(items: List<T>, selected: (T) -> Boolean, label: (T) -> String, onClick: (T) -> Unit) {
    LazyRow(
        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 2.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        items(items) { item ->
            val on = selected(item)
            FilterChip(
                selected = on,
                onClick = { onClick(item) },
                label = { Text(label(item), maxLines = 1) },
                colors = chipColors(),
                border = chipBorder(on),
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DatesDialog(onDismiss: () -> Unit, onPick: (LocalDate, LocalDate) -> Unit) {
    val state = rememberDateRangePickerState(
        selectableDates = object : SelectableDates {
            override fun isSelectableDate(utcTimeMillis: Long) = isPickableDay(utcTimeMillis)
        },
    )

    // The picker's dates are midnight UTC whatever the time zone.
    fun day(millis: Long) = Instant.ofEpochMilli(millis).atZone(ZoneOffset.UTC).toLocalDate()
    DatePickerDialog(
        onDismissRequest = onDismiss,
        confirmButton = {
            val start = state.selectedStartDateMillis
            TextButton(
                onClick = { start?.let { onPick(day(it), day(state.selectedEndDateMillis ?: it)) } },
                enabled = start != null,
            ) { Text("Search") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    ) {
        DateRangePicker(state, Modifier.weight(1f), title = { Text("Days to search", Modifier.padding(start = 24.dp, top = 16.dp)) })
    }
}

/**
 * Whether the picker's day at [utcTimeMillis], midnight UTC of that date, is no later
 * than [today] here. Comparing it with the current time instead would shut out today
 * east of UTC, before midnight UTC comes, and let in tomorrow west of it.
 */
internal fun isPickableDay(utcTimeMillis: Long, today: LocalDate = LocalDate.now()): Boolean =
    !Instant.ofEpochMilli(utcTimeMillis).atZone(ZoneOffset.UTC).toLocalDate().isAfter(today)

private fun dateSpan(from: LocalDate, to: LocalDate): String {
    val first = dayLabel(from.atStartOfDay(ZoneId.systemDefault()).toEpochSecond().toDouble())
    if (from == to) return first
    return "$first – ${dayLabel(to.atStartOfDay(ZoneId.systemDefault()).toEpochSecond().toDouble())}"
}

@Composable
private fun SearchResults(vm: AppViewModel, session: Session, imageLoader: ImageLoader, hits: SearchHits) {
    if (hits.isEmpty) {
        EmptyState(Icons.Outlined.SearchOff, "Nothing found", detail = "Try a longer time span or fewer filters.")
        return
    }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 16.dp)) {
        // At the top: a busy day alone can fill the limit, hiding everything older.
        if (hits.capped) {
            item {
                Text(
                    if (hits.objects.isEmpty()) {
                        "Showing the newest $SEARCH_LIMIT. Narrow the search to reach further back."
                    } else {
                        "Showing the closest $SEARCH_LIMIT matches."
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = Palette.TextSecondary,
                    modifier = Modifier.padding(start = 20.dp, end = 20.dp, top = 14.dp),
                )
            }
        }
        val byDay = hits.reviews.groupBy { dayLabel(it.startTime) }
        byDay.forEach { (day, items) ->
            item(key = "day-$day") { ResultDay(day, items.size) }
            items(items, key = { it.id }) { item ->
                ReviewRow(item, vm.cameraLabel(item.camera), session, imageLoader, trackReviews = vm.trackReviews) {
                    vm.openEvent(item)
                }
            }
        }
        items(hits.objects, key = { it.id }) { found ->
            ObjectRow(found, vm.cameraLabel(found.camera), session, imageLoader) {
                vm.search.openObject(session.api, found, vm::openEvent)
            }
        }
    }
}

@Composable
private fun ResultDay(day: String, count: Int) {
    Text(
        "$day · $count",
        style = MaterialTheme.typography.labelLarge.merge(Tabular),
        color = Palette.TextSecondary,
        modifier = Modifier.padding(start = 20.dp, top = 14.dp, bottom = 6.dp),
    )
}

/** A tracked object found by its description: picture, what, the description, and where and when. */
@Composable
private fun ObjectRow(found: TrackedObject, cameraLabel: String, session: Session, imageLoader: ImageLoader, onClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        AsyncImage(
            model = session.api.objectThumbnailUrl(found.id),
            imageLoader = imageLoader,
            contentDescription = null,
            contentScale = ContentScale.Crop,
            modifier = Modifier.width(96.dp).aspectRatio(1f).clip(RoundedCornerShape(10.dp)).background(Palette.SurfaceHigh),
        )
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(found.label.replaceFirstChar(Char::uppercase), style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium)
            found.data.description?.takeIf { it.isNotBlank() }?.let {
                Text(it, style = MaterialTheme.typography.bodyMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            Text(
                "$cameraLabel · ${dayLabel(found.startTime)}, ${formatTime(found.startTime)}",
                style = MaterialTheme.typography.bodySmall,
                color = Palette.TextSecondary,
            )
        }
    }
}
