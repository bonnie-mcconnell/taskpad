package com.taskpad.android

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import org.json.JSONObject

class MainActivity : ComponentActivity() {
  private lateinit var webView: WebView
  private val prefs by lazy { getSharedPreferences("taskpad_android", Context.MODE_PRIVATE) }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)

    webView = WebView(this).apply {
      settings.javaScriptEnabled = true
      settings.domStorageEnabled = true
      settings.databaseEnabled = true
      settings.allowFileAccess = true
      settings.allowContentAccess = true
      settings.allowFileAccessFromFileURLs = true
      // Required: the WebView loads from file:// assets and needs to fetch the sync Worker over HTTPS
      settings.allowUniversalAccessFromFileURLs = true
      settings.cacheMode = WebSettings.LOAD_DEFAULT
      settings.mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
      webChromeClient = WebChromeClient()
      webViewClient = WebViewClient()
      addJavascriptInterface(TaskpadAndroidBridge(), "TaskpadAndroid")
      loadUrl("file:///android_asset/taskpad/index.html")
    }

    setContentView(webView)

    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        moveTaskToBack(true)
      }
    })
  }

  override fun onResume() {
    super.onResume()
    if (::webView.isInitialized) {
      webView.onResume()
      webView.post {
        webView.evaluateJavascript("window.onTaskpadResume && window.onTaskpadResume();", null)
      }
    }
  }

  override fun onPause() {
    if (::webView.isInitialized) {
      webView.onPause()
    }
    super.onPause()
  }

  override fun onDestroy() {
    if (::webView.isInitialized) {
      webView.removeJavascriptInterface("TaskpadAndroid")
      webView.destroy()
    }
    super.onDestroy()
  }

  inner class TaskpadAndroidBridge {
    @JavascriptInterface
    fun getWorkerUrl(): String {
      for (path in listOf("taskpad/config.local.json", "taskpad/config.json")) {
        try {
          val raw = assets.open(path).bufferedReader().use { it.readText() }
          val workerUrl = JSONObject(raw).optString("workerUrl", "")
          if (workerUrl.isNotBlank()) return workerUrl
        } catch (_: Exception) {
          // Try the next config source.
        }
      }
      return ""
    }

    @JavascriptInterface
    fun onStateChanged(stateJson: String) {
      prefs.edit().putString("latest_state", stateJson).apply()
    }

    @JavascriptInterface
    fun hidePanel() {
      runOnUiThread { moveTaskToBack(true) }
    }

    @JavascriptInterface
    fun copyToClipboard(text: String) {
      val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
      clipboard.setPrimaryClip(ClipData.newPlainText("Taskpad", text))
    }
  }
}
