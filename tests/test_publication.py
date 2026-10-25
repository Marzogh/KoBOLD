import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location(
    'export_public', ROOT / 'tools/export_public.py'
)
publication = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publication)


class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'source'
        self.root.mkdir()
        self.output = Path(self.temp.name) / 'public'

    def put(self, name, text):
        p = self.root / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)
        return p

    def test_only_reviewed_files_and_fresh_history_are_exported(self):
        self.put('README.md', '# Product\n')
        self.put('AGENTS.md', 'private instructions')
        self.put('cache/backup.txt', 'private backup')
        self.put('.git/old-history', 'private history')
        # Export uses normal configured commit identity, but never copies old refs.
        env = dict(
            os.environ,
            GIT_AUTHOR_NAME='Test Maintainer',
            GIT_AUTHOR_EMAIL='test@example.invalid',
            GIT_COMMITTER_NAME='Test Maintainer',
            GIT_COMMITTER_EMAIL='test@example.invalid',
        )
        from unittest.mock import patch

        with patch.dict('os.environ', env):
            publication.export(
                self.root, self.output, 'source', {'source': ['README.md']}, True
            )
        self.assertEqual(
            subprocess.check_output(
                ['git', '-C', str(self.output), 'rev-list', '--all', '--count'],
                text=True,
            ).strip(),
            '1',
        )
        self.assertFalse((self.output / 'AGENTS.md').exists())
        self.assertFalse((self.output / 'cache').exists())
        self.assertFalse(
            subprocess.check_output(
                ['git', '-C', str(self.output), 'remote'], text=True
            ).strip()
        )

    def test_private_paths_secrets_instructions_and_traversal_fail_closed(self):
        bad = [
            '../secret',
            '/secret',
            'a/../secret',
            'cache/secret',
            'AGENTS.md',
            'x\\secret',
        ]
        for name in bad:
            with self.subTest(name=name), self.assertRaises(ValueError):
                publication.safe_path(name)
        examples = [
            ('/' + 'Users/alice/private/file'),
            ('# Build in ' + 'Codex\n'),
            ('tskey-auth-' + 'a' * 24),
        ]
        for text in examples:
            self.put('README.md', text)
            with self.subTest(kind='private-text'), self.assertRaises(ValueError):
                publication.export(
                    self.root, self.output, 'source', {'source': ['README.md']}
                )
            self.assertFalse(self.output.exists())

    def test_symlink_missing_file_and_unlisted_import_are_rejected(self):
        target = self.put('secret.txt', 'private')
        (self.root / 'README.md').symlink_to(target)
        with self.assertRaises(ValueError):
            publication.export(
                self.root, self.output, 'source', {'source': ['README.md']}
            )
        with self.assertRaises(ValueError):
            publication.export(
                self.root, self.output, 'source', {'source': ['missing.txt']}
            )
        self.put('web/app.js', "import './secret.js';\n")
        with self.assertRaises(ValueError):
            publication.export(
                self.root, self.output, 'source', {'source': ['web/app.js']}
            )

    def test_site_has_no_web_wrapper_and_no_unlisted_file(self):
        self.put('web/index.html', '<title>Product</title>')
        self.put('web/private.txt', 'private')
        publication.export(self.root, self.output, 'site', {'site': ['web/index.html']})
        self.assertTrue((self.output / 'index.html').is_file())
        self.assertFalse((self.output / 'web').exists())
        self.assertFalse((self.output / 'private.txt').exists())
        with self.assertRaises(ValueError):
            publication.export(
                self.root, self.output, 'site', {'site': ['web/index.html']}
            )

    def test_directory_navigation_resolves_to_listed_index(self):
        self.put('web/index.html', '<a href="./#overview">Home</a>')
        publication.export(self.root, self.output, 'site', {'site': ['web/index.html']})
        records = json.loads((self.output / 'PUBLICATION.json').read_text())['files']
        self.assertIn('index.html', records)
        self.assertTrue(all((self.output / path).is_file() for path in records))

    def test_public_document_cannot_reference_private_work_log(self):
        self.put('README.md', 'See CURRENT-' + 'HANDOFF.md for the conversation.')
        with self.assertRaises(ValueError):
            publication.export(
                self.root, self.output, 'source', {'source': ['README.md']}
            )

    def test_unlisted_html_script_is_rejected_before_copy(self):
        self.put('web/index.html', '<script src="./private.js"></script>')
        with self.assertRaises(ValueError):
            publication.export(
                self.root, self.output, 'site', {'site': ['web/index.html']}
            )
        self.assertFalse(self.output.exists())

    def test_preview_marker_matches_published_checksum_and_source_is_untouched(self):
        original = '<html><head><title>Preview</title></head></html>'
        self.put('web/index.html', original)
        publication.export(
            self.root, self.output, 'site', {'site': ['web/index.html']}, preview=True
        )
        text = (self.output / 'index.html').read_text()
        self.assertIn('name="kobold-site-mode" content="preview"', text)
        self.assertEqual((self.root / 'web/index.html').read_text(), original)
        manifest = json.loads((self.output / 'PUBLICATION.json').read_text())
        self.assertTrue(manifest['preview'])
        import hashlib

        self.assertEqual(
            manifest['files']['index.html']['sha256'],
            hashlib.sha256(text.encode()).hexdigest(),
        )

    def test_preview_omits_standalone_native_entry_pages(self):
        self.put('web/index.html', '<html><head></head></html>')
        self.put('web/upgrade.html', '<button>Prepare update</button>')
        self.put('web/diagnostics.html', '<button>Read native diagnostics</button>')
        publication.export(
            self.root,
            self.output,
            'site',
            {'site': ['web/index.html', 'web/upgrade.html', 'web/diagnostics.html']},
            preview=True,
        )
        self.assertFalse((self.output / 'upgrade.html').exists())
        self.assertFalse((self.output / 'diagnostics.html').exists())

    def test_preview_rejects_native_payload_and_candidate_modes(self):
        with self.assertRaises(ValueError):
            publication.export(
                self.root,
                self.output,
                'site',
                {'site': ['web/index.html']},
                candidate=True,
                preview=True,
            )
        with self.assertRaises(ValueError):
            publication.export(
                self.root,
                self.output,
                'site',
                {'site': ['web/releases/0.1.0/bootstrap.tgz']},
                preview=True,
            )
        self.assertFalse(self.output.exists())

    def test_signed_or_attended_release_cannot_use_candidate_export(self):
        self.put(
            'web/releases/0.1.0/manifest.json',
            json.dumps(
                {'channel': 'attended-trial', 'profile': {'bootstrapAccepted': False}}
            ),
        )
        self.put(
            'web/releases/0.1.0/manifest.signed.json', json.dumps({'unsigned': True})
        )
        with self.assertRaises(ValueError):
            publication.candidate_files(self.root)


if __name__ == '__main__':
    unittest.main()
