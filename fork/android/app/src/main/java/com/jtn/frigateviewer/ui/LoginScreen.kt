package com.jtn.frigateviewer.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Videocam
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp

@Composable
fun LoginScreen(vm: AppViewModel) {
    val saved = vm.savedSettings
    var url by rememberSaveable { mutableStateOf(saved.baseUrl.trimEnd('/')) }
    var user by rememberSaveable { mutableStateOf(saved.username) }
    var password by rememberSaveable { mutableStateOf("") }
    var selfSigned by rememberSaveable { mutableStateOf(saved.selfSignedCert) }

    Column(
        Modifier
            .fillMaxSize()
            .safeDrawingPadding()
            .imePadding()
            .verticalScroll(rememberScrollState())
            .padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Column(Modifier.widthIn(max = 480.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
            Column(Modifier.padding(horizontal = 4.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Box(
                    Modifier.size(56.dp).clip(CircleShape).background(Palette.Accent.copy(alpha = 0.16f)),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(Icons.Outlined.Videocam, contentDescription = null, tint = Palette.Accent, modifier = Modifier.size(28.dp))
                }
                Text("Frigate", style = MaterialTheme.typography.headlineLarge)
                Text(
                    "Connect to your Frigate server. Use port 8971 with your Frigate login, " +
                        "or port 5000 without one.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = Palette.TextSecondary,
                )
            }
            Group("Server") {
                OutlinedTextField(
                    value = url,
                    onValueChange = {
                        url = it
                        // An error is about what was entered; editing it starts over.
                        vm.clearLoginError()
                    },
                    label = { Text("Server address") },
                    placeholder = { Text("https://192.168.1.10:8971") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Next),
                    modifier = Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 12.dp),
                )
                Toggle(
                    "Self-signed certificate",
                    "For Frigate's built-in HTTPS on port 8971. You confirm the certificate once, " +
                        "and after that only that certificate is trusted.",
                    checked = selfSigned,
                    onChange = {
                        selfSigned = it
                        vm.clearLoginError()
                    },
                )
            }
            Group("Login") {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    OutlinedTextField(
                        value = user,
                        onValueChange = {
                            user = it
                            vm.clearLoginError()
                        },
                        label = { Text("Username (optional)") },
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    OutlinedTextField(
                        value = password,
                        onValueChange = {
                            password = it
                            vm.clearLoginError()
                        },
                        label = { Text("Password") },
                        singleLine = true,
                        visualTransformation = PasswordVisualTransformation(),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done),
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
            vm.loginError?.let {
                Text(
                    it,
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.padding(horizontal = 4.dp),
                )
            }
            Button(
                onClick = { vm.login(url, user, password, selfSigned) },
                enabled = url.isNotBlank() && !vm.loggingIn,
                modifier = Modifier.fillMaxWidth().height(52.dp),
            ) {
                if (vm.loggingIn) {
                    CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                } else {
                    Text("Connect")
                }
            }
        }
    }

    vm.pendingCertificate?.let { CertificateDialog(it, onTrust = vm::trustCertificate, onCancel = vm::rejectCertificate) }
}

/** Asks the user to trust a self-signed certificate before any password is sent. */
@Composable
internal fun CertificateDialog(pending: PendingCertificate, onTrust: () -> Unit, onCancel: () -> Unit) {
    AlertDialog(
        onDismissRequest = onCancel,
        title = { Text(if (pending.changed) "Certificate changed" else "Trust this certificate?") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(
                    if (pending.changed) {
                        "This server now presents a different certificate from the one you trusted. " +
                            "Continue only if you replaced it, for example by reinstalling Frigate."
                    } else {
                        "The server uses a self-signed certificate. Check that this SHA-256 fingerprint " +
                            "matches the one your browser shows for the server."
                    },
                    style = MaterialTheme.typography.bodyMedium,
                )
                Text(pending.fingerprint, style = MonoSmall, color = Palette.TextPrimary)
            }
        },
        confirmButton = { TextButton(onClick = onTrust) { Text("Trust") } },
        dismissButton = { TextButton(onClick = onCancel) { Text("Cancel") } },
    )
}
