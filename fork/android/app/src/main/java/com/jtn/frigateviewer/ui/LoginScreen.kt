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
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.jtn.frigateviewer.R

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
                Text(stringResource(R.string.app_name), style = MaterialTheme.typography.headlineLarge)
                Text(
                    stringResource(R.string.set_login_intro),
                    style = MaterialTheme.typography.bodyMedium,
                    color = Palette.TextSecondary,
                )
            }
            Group(stringResource(R.string.set_group_server)) {
                OutlinedTextField(
                    value = url,
                    onValueChange = {
                        url = it
                        // An error is about what was entered; editing it starts over.
                        vm.clearLoginError()
                    },
                    label = { Text(stringResource(R.string.set_login_address)) },
                    placeholder = { Text("https://192.168.1.10:8971") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Next),
                    modifier = Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 12.dp),
                )
                Toggle(
                    stringResource(R.string.set_login_self_signed),
                    stringResource(R.string.set_login_self_signed_detail),
                    checked = selfSigned,
                    onChange = {
                        selfSigned = it
                        vm.clearLoginError()
                    },
                )
            }
            Group(stringResource(R.string.set_login_group)) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    OutlinedTextField(
                        value = user,
                        onValueChange = {
                            user = it
                            vm.clearLoginError()
                        },
                        label = { Text(stringResource(R.string.set_login_username)) },
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
                        label = { Text(stringResource(R.string.set_login_password)) },
                        singleLine = true,
                        visualTransformation = PasswordVisualTransformation(),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done),
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
            vm.loginError?.let {
                Text(
                    it.resolve(),
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
                    Text(stringResource(R.string.set_login_connect))
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
        title = { Text(stringResource(if (pending.changed) R.string.set_cert_changed else R.string.set_cert_trust_title)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(
                    stringResource(if (pending.changed) R.string.set_cert_changed_detail else R.string.set_cert_trust_detail),
                    style = MaterialTheme.typography.bodyMedium,
                )
                Text(pending.fingerprint, style = MonoSmall, color = Palette.TextPrimary)
            }
        },
        confirmButton = { TextButton(onClick = onTrust) { Text(stringResource(R.string.set_cert_trust)) } },
        dismissButton = { TextButton(onClick = onCancel) { Text(stringResource(R.string.cancel)) } },
    )
}
