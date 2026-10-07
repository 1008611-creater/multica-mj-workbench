"""Local contracts only: no browser, login, platform request or charge."""
import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock
from workbench_params import prepare_request, request_fingerprint
from workbench_assets import AssetLibrary
from batch_queue import BatchManager, BatchError
import server

PNG = __import__('base64').b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXsAAAAAASUVORK5CYII=')

class ParameterTests(unittest.TestCase):
    def test_transport_and_identity(self):
        p = prepare_request('A quiet scene', '16:9', 'v7', {'stylize': 300, 'seed': 0, 'raw': True, 'quality': 2})
        self.assertIn('--seed 0', p['effectivePrompt'])
        self.assertIn('--quality 2', p['effectivePrompt'])
        self.assertEqual(p['parameterVerification'], 'transport_only')
        self.assertEqual(request_fingerprint(p, 'C:/PROFILE'), request_fingerprint(p, 'c:/profile'))
        for field, value in [('aspect', '9:16'), ('version', 'v6.1'), ('params', {'seed': 1})]:
            self.assertNotEqual(request_fingerprint(p, 'p'), request_fingerprint({**p, field: value}, 'p'))

    def test_invalid_values_are_not_silently_dropped(self):
        for params in [{'chaos': 101}, {'seed': -1}, {'stylize': 1.5}, {'raw': 1}, {'quality': 4}, {'extra': 1}, {'chaos': float('nan')}]:
            with self.subTest(params=params), self.assertRaises(ValueError):
                prepare_request('scene', '16:9', 'v8.2', params)
        for prompt in ['scene --seed 1', 'scene\x00']:
            with self.assertRaises(ValueError):
                prepare_request(prompt, '16:9', 'v7', {})

class DurableDispatchTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.patch = mock.patch.multiple(server, JOBS_DIR=self.root/'jobs', RESULTS_DIR=self.root/'output', PROFILE_PATH=self.root/'profile', BATCH_SLOT_ROOT=self.root/'slots')
        self.patch.start()
        server.JOBS_DIR.mkdir()
    def tearDown(self):
        self.patch.stop()
        self.tmp.cleanup()
    def request(self, **kwargs):
        return server.JobRequest(prompt='A quiet scene', label='same-name', aspect='16:9', version='v7', **kwargs)
    def content(self, response):
        return json.loads(response.body)
    def test_dedupes_intent_even_after_timeout_and_force(self):
        with mock.patch.object(server.subprocess, 'run', side_effect=server.subprocess.TimeoutExpired('node', 90)) as runner:
            first = self.content(server.create_job(self.request(params={'seed': 1})))
            second = self.content(server.create_job(self.request(params={'seed': 1}, force=True)))
            self.assertEqual(first['status'], 'dispatch_uncertain')
            self.assertEqual(first['jobId'], second['jobId'])
            self.assertEqual(runner.call_count, 1)
            self.assertEqual(server.read_job(first['jobId'])['status'], 'stale')
    def test_different_params_and_completed_attempt_have_unique_ids(self):
        with mock.patch.object(server.subprocess, 'run', return_value=mock.Mock(stdout='{"status":"bg_started","pid":123}', stderr='')) as runner:
            one = self.content(server.create_job(self.request(params={'seed': 1})))
            two = self.content(server.create_job(self.request(params={'seed': 2})))
            (server.JOBS_DIR/(one['jobId']+'.json')).write_text('{"ok":true,"status":"ok"}', encoding='utf-8')
            three = self.content(server.create_job(self.request(params={'seed': 1})))
            self.assertEqual(len({one['jobId'], two['jobId'], three['jobId']}), 3)
            command = runner.call_args.args[0]
            self.assertIn('--seed 1', command[command.index('--prompt')+1])
            self.assertEqual(runner.call_args.kwargs['env']['MXAI_PROFILE'], str(server.PROFILE_PATH.resolve()))
    def test_malformed_result_is_unknown_not_success(self):
        (server.JOBS_DIR/'job.json').write_text('[1,2]', encoding='utf-8')
        state=server.read_job('job')
        self.assertFalse(state['ok'])
        self.assertIsNone(state['submitted'])

class BatchControlEndpointTests(unittest.TestCase):
    def test_control_routes_forward_current_authorization_and_pause_reason(self):
        # Only a local manager mock: no browser, subprocess, login or generation.
        manager = mock.Mock()
        with mock.patch.object(server, 'batch_manager', manager):
            server.start_batch('batch', None)
            manager.start.assert_called_once_with('batch', False)
            server.start_batch('batch', {'paid_confirmed': True})
            self.assertEqual(manager.start.call_args.args, ('batch', True))
            server.resume_batch('batch', None)
            manager.resume.assert_called_once_with('batch', False)
            server.resume_batch('batch', {'paid_confirmed': True})
            self.assertEqual(manager.resume.call_args.args, ('batch', True))
            for invalid in ('false', 1, [], None):
                server.start_batch('batch', {'paid_confirmed': invalid})
                self.assertEqual(manager.start.call_args.args, ('batch', False))
                server.resume_batch('batch', {'paid_confirmed': invalid})
                self.assertEqual(manager.resume.call_args.args, ('batch', False))
                server.resubmit_batch_item('batch', 'item', {'paid_confirmed': invalid, 'confirm_repeat_charge': invalid})
                self.assertEqual(manager.resubmit.call_args.args, ('batch', 'item', False, False))
            server.pause_batch('batch', {'reason': 'review results'})
            manager.pause.assert_called_once_with('batch', 'review results')
            server.pause_batch('batch', None)
            self.assertEqual(manager.pause.call_args.args, ('batch', '用户已暂停补位'))

class LibraryTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
        (self.root/'jobs').mkdir();(self.root/'batches').mkdir()
        self.image=self.root/'real.png';self.image.write_bytes(PNG)
        (self.root/'jobs'/'real.json').write_text(json.dumps({'ok':True,'images':[str(self.image)],'recordId':'real-serial'}),encoding='utf-8')
        self.library=AssetLibrary(self.root/'jobs', self.root/'batches', self.root/'receipts.jsonl', self.root/'annotations.json')
    def tearDown(self):self.tmp.cleanup()
    def test_annotations_persist_and_missing_metadata_stays_missing(self):
        a=self.library.index()[0]
        self.assertIsNone(a['prompt']);self.assertIsNone(a['params']);self.assertEqual(a['recordId'],'real-serial')
        self.library.annotate(a['id'],{'favorite':True,'tags':['selected','selected'],'archived':True})
        fresh=AssetLibrary(self.root/'jobs',self.root/'batches',self.root/'receipts.jsonl',self.root/'annotations.json').index()[0]
        self.assertTrue(fresh['favorite']);self.assertEqual(fresh['tags'],['selected']);self.assertTrue(self.image.read_bytes()==PNG)
    def test_does_not_accept_arbitrary_paths_or_fake_image_extension(self):
        bad=self.root/'fake.png';bad.write_text('<html>error</html>')
        (self.root/'jobs'/'fake.json').write_text(json.dumps({'images':[str(bad)]}),encoding='utf-8')
        self.assertEqual(len(self.library.index()),1)
        with self.assertRaises(KeyError):self.library.get(str(self.image))
        with self.assertRaises(ValueError):self.library.annotate(self.library.index()[0]['id'],{'path':str(bad)})
    def test_cached_image_replaced_by_html_is_rejected(self):
        asset=self.library.index()[0]
        self.image.write_text('<html>replacement</html>',encoding='utf-8')
        with self.assertRaises(KeyError):self.library.get(asset['id'])
    def test_corrupt_notes_are_preserved(self):
        p=self.root/'annotations.json';p.write_text('{broken',encoding='utf-8')
        with self.assertRaises(ValueError):self.library.index()
        self.assertEqual(p.read_text(),'{broken')
    def test_request_and_receipt_association(self):
        (self.root/'jobs'/'requests').mkdir()
        (self.root/'jobs'/'requests'/'real.json').write_text(json.dumps({'prompt':'source','effectivePrompt':'source --seed 1','params':{'seed':1}}),encoding='utf-8')
        (self.root/'receipts.jsonl').write_text(json.dumps({'serial':'real-serial','files':[{'file':str(self.image),'w':1,'h':1,'sha256':'recorded'}]}),encoding='utf-8')
        a=self.library.index()[0]
        self.assertEqual((a['prompt'],a['width'],a['sha256']),('source',1,'recorded'))

class MaterialDeliveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
        self.data=self.root/'run';self.data.mkdir();(self.data/'jobs').mkdir();(self.data/'batches').mkdir()
        self.image=self.root/'original.png';self.image.write_bytes(PNG)
        (self.data/'jobs'/'real.json').write_text(json.dumps({'images':[str(self.image)],'submitted':True,'billed':None}),encoding='utf-8')
        (self.data/'jobs'/'requests').mkdir()
        (self.data/'jobs'/'requests'/'real.json').write_text(json.dumps({'prompt':'local contract fixture','aspect':'9:16','version':'v7','params':{'seed':0}}),encoding='utf-8')
        self.library=AssetLibrary(self.data/'jobs',self.data/'batches',self.data/'receipts.jsonl',self.data/'annotations.json')
        self.output=self.root/'output';self.material=self.root/'project-assets'
        self.asset=self.library.index()[0]
    def tearDown(self):self.tmp.cleanup()
    def test_copy_keeps_exact_bytes_and_provenance_and_is_idempotent(self):
        self.library.configure_storage({'outputDir':str(self.output),'materialDir':str(self.material)},self.output)
        first=self.library.deliver([self.asset['id']],self.output)
        self.assertTrue(first['ok']);self.assertEqual(first['items'][0]['status'],'copied')
        target=Path(first['items'][0]['path']);self.assertEqual(target.read_bytes(),PNG)
        note=json.loads(Path(first['items'][0]['metadataPath']).read_text(encoding='utf-8'))
        self.assertEqual((note['prompt'],note['requestedAspect'],note['params']),('local contract fixture','9:16',{'seed':0}))
        self.assertIsNone(note['billed']);self.assertEqual(self.image.read_bytes(),PNG)
        again=self.library.deliver([self.asset['id']],self.output)
        self.assertTrue(again['ok']);self.assertEqual(again['items'][0]['status'],'already_present')
        self.assertEqual(len(list(target.parent.iterdir())),2)
    def test_conflict_is_preserved_and_reported(self):
        self.library.configure_storage({'materialDir':str(self.material)},self.output)
        first=self.library.deliver([self.asset['id']],self.output)
        target=Path(first['items'][0]['path']);target.write_bytes(b'other content')
        second=self.library.deliver([self.asset['id']],self.output)
        self.assertFalse(second['ok']);self.assertEqual(target.read_bytes(),b'other content')
    def test_invalid_ids_and_protected_paths_do_not_write(self):
        for path in (str(self.data),str(self.data/'jobs'/'new'),str(self.root.anchor),'relative'):
            with self.subTest(path=path),self.assertRaises(ValueError):self.library.configure_storage({'materialDir':path},self.output)
        self.library.configure_storage({'materialDir':str(self.material)},self.output)
        with self.assertRaises(KeyError):self.library.deliver([self.asset['id'],'not-an-asset'],self.output)
        self.assertFalse(self.material.exists())
        with self.assertRaises(ValueError):self.library.deliver([self.asset['id']]*2,self.output)
    def test_modified_original_cannot_claim_a_recorded_receipt_hash(self):
        receipt={'files':[{'file':str(self.image),'sha256':'0'*64}]}
        (self.data/'receipts.jsonl').write_text(json.dumps(receipt),encoding='utf-8')
        self.library._cache=None
        self.library.configure_storage({'materialDir':str(self.material)},self.output)
        result=self.library.deliver([self.asset['id']],self.output)
        self.assertFalse(result['ok']);self.assertEqual(list((self.material/'multica-assets').iterdir()),[])
    def test_settings_survive_restart_and_do_not_change_existing_batches(self):
        self.library.configure_storage({'outputDir':str(self.output),'materialDir':str(self.material)},self.root/'default')
        fresh=AssetLibrary(self.data/'jobs',self.data/'batches',self.data/'receipts.jsonl',self.data/'annotations.json')
        self.assertEqual(fresh.storage(self.root/'default')['outputDir'],str(self.output))
        with mock.patch.object(server,'asset_library',fresh),mock.patch.object(server,'RESULTS_DIR',self.root/'default'):
            self.assertEqual(server._batch_output({'name':'new'})['outputDir'],str(self.output))
            self.assertEqual(server._batch_output({'outputDir':'D:/previous'})['outputDir'],'D:/previous')
    def test_corrupt_settings_and_sidecar_are_not_overwritten(self):
        self.library.configure_storage({'materialDir':str(self.material)},self.output)
        first=self.library.deliver([self.asset['id']],self.output)
        note=Path(first['items'][0]['metadataPath']);note.write_text('[]',encoding='utf-8')
        self.assertFalse(self.library.deliver([self.asset['id']],self.output)['ok']);self.assertEqual(note.read_text(),'[]')
        config=self.data/'library-storage.json';config.write_text('{broken',encoding='utf-8')
        with self.assertRaises(ValueError):self.library.configure_storage({'materialDir':''},self.output)
        self.assertEqual(config.read_text(),'{broken')

class QueueReliabilityTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);(self.root/'output').mkdir()
        self.calls=[];self.jobs={};self.managers=[]
    def tearDown(self):
        for m in self.managers:
            for b in m.list_summaries():
                m.cancel(b['batchId'])
                for item in m.get_state(b['batchId'])['items']:
                    if item.get('currentJobId'):self.jobs[item['currentJobId']]={'status':'stale','submitted':None}
        time.sleep(.08);self.tmp.cleanup()
    def manager(self, folder='batches'):
        def submit(item):
            job='local-contract-'+item['id'];self.calls.append(item);self.jobs[job]={'jobId':job,'status':'running'};return self.jobs[job]
        m=BatchManager(self.root/folder,submit,lambda job:self.jobs[job],self.root/'output',self.root/'slots',poll_seconds=.015,shared_profile=self.root/'shared')
        self.managers.append(m);return m
    def payload(self,mode='shared'):
        return {'batchId':'test-only','profileMode':mode,'items':[{'id':f't{i}','prompt':f'local contract scene {i}'} for i in range(4)]}
    def wait(self,fn):
        deadline=time.time()+2
        while time.time()<deadline:
            if fn():return
            time.sleep(.02)
        self.fail('local contract did not reach expected state')
    def test_shared_reserves_one_slot_and_per_slot_reserves_three(self):
        m=self.manager();m.create(self.payload());m.start('test-only',True)
        self.wait(lambda:len(self.calls)==1)
        time.sleep(.05);self.assertEqual(len(self.calls),1);m.cancel('test-only')
        other=self.manager('independent');other.create(self.payload('per_slot'));other.start('test-only',True)
        self.wait(lambda:len(self.calls)==4)
        self.assertEqual(len({c['profile'] for c in self.calls[1:]}),3)
    def test_unknown_submission_cannot_be_retried_and_restart_does_not_submit(self):
        m=self.manager();m.create(self.payload());m.start('test-only',True);self.wait(lambda:len(self.calls)==1)
        self.jobs['local-contract-t0']={'status':'stale','submitted':None,'chargeKnown':False}
        self.wait(lambda:m.get_state('test-only')['status']=='paused')
        with self.assertRaises(BatchError):m.resubmit('test-only','t0',True,True)
        before=len(self.calls);restarted=self.manager();time.sleep(.05)
        self.assertEqual(len(self.calls),before)
        self.assertEqual(restarted.get_state('test-only')['items'][0]['currentJobId'],'local-contract-t0')
    def test_recover_links_original_image_without_resubmitting(self):
        m=self.manager();m.create(self.payload());m.start('test-only',True);self.wait(lambda:len(self.calls)==1)
        self.jobs['local-contract-t0']={'status':'stale','submitted':None,'chargeKnown':False}
        self.wait(lambda:m.get_state('test-only')['status']=='paused')
        img=self.root/'output'/'verified.png';img.write_bytes(PNG)
        self.jobs['local-contract-t0']={'status':'done','ok':True,'images':[str(img)],'submitted':True}
        m.recover('test-only')
        self.assertEqual(m.get_state('test-only')['items'][0]['status'],'completed')
        self.assertEqual(len(self.calls),1)
    def test_cancel_keeps_polling_already_submitted_job(self):
        m=self.manager();m.create(self.payload());m.start('test-only',True);self.wait(lambda:len(self.calls)==1)
        m.cancel('test-only');img=self.root/'output'/'verified.png';img.write_bytes(PNG)
        self.jobs['local-contract-t0']={'status':'done','ok':True,'images':[str(img)],'submitted':True}
        self.wait(lambda:m.get_state('test-only')['items'][0]['status']=='completed')
        self.assertEqual(len(self.calls),1)

    def test_recover_cancelled_login_result_does_not_resume_dispatch(self):
        m=self.manager();m.create(self.payload());m.start('test-only',True)
        self.wait(lambda:len(self.calls)==1)
        self.jobs['local-contract-t0']={'status':'stale','submitted':None}
        self.wait(lambda:m.get_state('test-only')['status']=='paused')
        m.cancel('test-only')
        self.jobs['local-contract-t0']={'status':'need_login','submitted':False}
        state=m.recover('test-only')
        self.assertEqual(state['status'],'cancelled')
        self.assertEqual(state['items'][0]['status'],'login_required')
        time.sleep(.05);self.assertEqual(len(self.calls),1)

if __name__=='__main__':unittest.main()
