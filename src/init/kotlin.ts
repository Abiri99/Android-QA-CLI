/**
 * The canonical `AgentQa.kt`, as a template with exactly one substitution.
 *
 * It is a fixed string rather than something generated per project because its
 * chunking and sequence numbering fail SILENTLY when altered: a wrong chunk
 * boundary produces half a JSON payload that the reader discards without
 * complaint, and a non-monotonic sequence looks exactly like the dropped line
 * that gap detection exists to catch. Nothing here is project-specific except
 * the package line.
 */

export const WIRE_VERSION = 'v1'

export function agentQaKotlin(packageName: string): string {
  return `package ${packageName}

import android.util.Log
import java.util.concurrent.atomic.AtomicLong

/**
 * Emits this app's state and events to logcat for \`agentqa\` to read.
 *
 * Disabled until [enable] is called, so nothing reaches the log in a release
 * build. Call it once, at your entry point:
 *
 *     if (BuildConfig.DEBUG) AgentQa.enable()
 *
 * Never emit credentials, tokens, or personal data: everything passed here
 * lands in the device log.
 *
 * Requires Kotlin 1.5 or newer (uses \`Char.code\`).
 *
 * Chunking splits payload strings by UTF-16 char count and can land exactly
 * inside a surrogate pair; when it does, the astral character (many emoji) on
 * that boundary is replaced by U+FFFD in the reassembled JSON string. This is
 * a known, accepted limit rather than a bug to chase.
 */
object AgentQa {
    private const val TAG = "AgentQA"
    private const val MARKER = "AGENTQA|${WIRE_VERSION}|"

    /**
     * logcat truncates a line at roughly 4068 BYTES, including the header the
     * system prepends. \`String.chunked\` below counts UTF-16 CHARACTERS, not
     * bytes, and a UTF-8-encoded character can take up to 4 bytes. So this
     * constant is sized for the worst case: 900 chars * 4 bytes/char = 3600
     * bytes, leaving roughly 468 bytes of headroom for the logcat header plus
     * this line's own prefix (marker, sequence, kind, key, chunk notation).
     * Do not "optimise" this back up toward 3000 — that number only works for
     * ASCII payloads and silently truncates mid-chunk for CJK text, accented
     * names, or emoji, producing a chunk that looks complete but decodes to
     * broken JSON.
     */
    private const val MAX_CHUNK = 900

    @Volatile
    private var enabled = false

    /**
     * One number per LINE on the wire, not per record: a chunked payload
     * consumes one for each chunk. The reader treats any break in the run as a
     * dropped line and marks earlier values stale, so this must never skip or
     * repeat.
     *
     * Atomic only buys UNIQUENESS of each number. It does NOT make a record's
     * lines contiguous, and it does NOT make log order match allocation order
     * — two threads can allocate 1 and 2 and then log 2 before 1, which the
     * reader sees as a gap. The \`synchronized\` block in [emit] is what buys
     * both of those; see the comment there.
     */
    private val seq = AtomicLong(0)

    @JvmStatic
    fun enable() {
        enabled = true
    }

    @JvmStatic
    val isEnabled: Boolean
        get() = enabled

    /** Current value of something. Last write for a key wins. */
    @JvmStatic
    fun state(key: String, value: Any?) = emit("state", key, value)

    /** Something that happened. Appended in order. */
    @JvmStatic
    @JvmOverloads
    fun event(name: String, data: Any? = null) = emit("event", name, data)

    private fun emit(kind: String, key: String, value: Any?) {
        if (!enabled) return
        try {
            val payload = toJson(value)
            val chunks = if (payload.isEmpty()) listOf("") else payload.chunked(MAX_CHUNK)
            val total = chunks.size
            // The lock spans allocation AND logging, for every chunk of this
            // record. Without it two threads emitting the SAME key with
            // chunked payloads interleave on the wire (A1/2, B1/2, A2/2), and
            // the reader — which buffers one partial per key — overwrites A's
            // first half with B's, then splices B's first half onto A's second
            // and serves the result as a complete, fresh record. Sequence
            // numbers stay contiguous, so nothing downstream flags it. The
            // milder version of the same race is two single-chunk emissions
            // logging out of allocation order, which reads as a dropped line
            // and marks everything stale. Contention is irrelevant at the
            // frequencies this is meant for, and emission is off entirely in
            // release.
            synchronized(this) {
                for (i in chunks.indices) {
                    val n = seq.incrementAndGet()
                    Log.i(TAG, MARKER + n + "|" + kind + "|" + key + "|" + (i + 1) + "/" + total + "|" + chunks[i])
                }
            }
        } catch (t: Throwable) {
            // Instrumentation must never crash the app it observes. A value we
            // cannot encode is worth losing; the app is not.
        }
    }

    private fun toJson(value: Any?): String = when (value) {
        null -> "null"
        is Boolean -> value.toString()
        is Float -> if (value.isFinite()) value.toString() else quote(value.toString())
        is Double -> if (value.isFinite()) value.toString() else quote(value.toString())
        is Number -> value.toString()
        is CharSequence -> quote(value.toString())
        is Map<*, *> -> value.entries.joinToString(",", "{", "}") {
            quote(it.key.toString()) + ":" + toJson(it.value)
        }
        is Iterable<*> -> value.joinToString(",", "[", "]") { toJson(it) }
        // Anything else becomes a quoted toString(). The reader keeps it — an
        // unparseable value is still evidence — but a state predicate cannot
        // match into it, which is why the skill asks for primitives and maps.
        else -> quote(value.toString())
    }

    private fun quote(s: String): String {
        val sb = StringBuilder(s.length + 2)
        sb.append('"')
        for (c in s) {
            when {
                c == '"' -> sb.append("\\\\\\"")
                c == '\\\\' -> sb.append("\\\\\\\\")
                c == '\\n' -> sb.append("\\\\n")
                c == '\\r' -> sb.append("\\\\r")
                c == '\\t' -> sb.append("\\\\t")
                // A raw control character would break the one-line wire format.
                c < ' ' -> sb.append(String.format("\\\\u%04x", c.code))
                else -> sb.append(c)
            }
        }
        sb.append('"')
        return sb.toString()
    }
}
`
}

/**
 * The Compose half, kept out of the core file so that file has no Compose
 * import and compiles in a View-based app.
 *
 * An extension function rather than a member: Kotlin cannot add a member to an
 * `object` from another file. It still reads as `AgentQa.semanticsModifier()`
 * at the call site.
 */
export function agentQaComposeKotlin(packageName: string): string {
  return `package ${packageName}

import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId

/**
 * Makes Compose \`testTag\`s visible to \`uiautomator\`, so \`agentqa\` can select
 * elements by tag. Apply once at your Compose root:
 *
 *     Box(modifier = AgentQa.semanticsModifier()) { ... }
 *
 * Returns a bare Modifier when AgentQa is disabled, so a release build carries
 * no extra semantics.
 *
 * The \`@OptIn\` is required: \`testTagsAsResourceId\` is marked
 * \`@ExperimentalComposeUiApi\`, which is \`@RequiresOptIn\` at ERROR level in
 * every widely-deployed Compose UI release, so omitting it is a compile error
 * rather than a warning. On a newer Compose where the API has stabilised the
 * opt-in is merely unnecessary, which is a warning — safe in both directions.
 */
@Suppress("UnusedReceiverParameter")
@OptIn(androidx.compose.ui.ExperimentalComposeUiApi::class)
fun AgentQa.semanticsModifier(): Modifier =
    if (AgentQa.isEnabled) Modifier.semantics { testTagsAsResourceId = true } else Modifier
`
}
