# Browser sessions

Settings and workflow progress are local to the browser session. Directory handles
are browser-managed permissions, not proof that the same reader remains connected.
After refresh or reconnection, revalidate identity, saved request and required
permissions before restoring actions. No native write is replayed by restoration.

A saved policy acknowledgement is retained only when it still corresponds to the
reconstructed settings. Endpoint recognition reads the current configuration;
visual step completion alone does not authorise startup. Incomplete preparations
and backups remain incomplete until their normal checks succeed.

Browser storage can be disabled, cleared or restored with an old tab. Do not
promise secure deletion at window close. Stored policy text is accessible to
same-origin scripts and is not an encrypted credential vault. Folder access may
need user approval again; keep recovery backups independently of browser state.

The wizard redesign adds distinct diagnostic sessions, bounded always-on event
collection and a separate log visibility control. Those new semantics must be
validated in the final integrated UI. They do not imply that every legacy session
or status path has already been converted to lightweight checks.
