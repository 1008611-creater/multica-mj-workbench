import json
import tempfile
import time
import unittest
from pathlib import Path

from batch_queue import BatchError, BatchManager, validate_payload


class FakeAdapter:
    def __init__(self, output: Path, fail_ids=None, login_ids=None):
        self.output = output
        self.fail_ids = set(fail_ids or [])
        self.login_ids = set(login_ids or [])
        self.submitted = []
        self.jobs = {}

    def submit(self, item):
        job_id = f"fake-{item['id']}-{item['attempts']}"
        self.submitted.append(item["id"])
        self.jobs[job_id] = item
        return {"jobId": job_id, "status": "running", "submitted": True, "chargeKnown": True}

    def get(self, job_id):
        item = self.jobs[job_id]
        if item["id"] in self.login_ids:
            return {"jobId": job_id, "status": "done", "ok": False, "resultStatus": "need_login", "submitted": False, "billed": False, "chargeKnown": True, "message": "simulated login required"}
        if item["id"] in self.fail_ids:
            return {"jobId": job_id, "status": "done", "ok": False, "resultStatus": "rejected", "billed": True, "chargeKnown": True, "message": "模拟失败"}
        output = self.output / f"{item['id']}.png"
        output.write_bytes(__import__("base64").b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXsAAAAAASUVORK5CYII="))
        return {"jobId": job_id, "status": "done", "ok": True, "images": [str(output)], "resultStatus": "succeeded", "billed": True, "chargeKnown": True}


def wait_until(predicate, timeout=4):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(0.03)
    return False


class BatchQueueTests(unittest.TestCase):
    def make_manager(self, root, adapter):
        return BatchManager(root / "batches", adapter.submit, adapter.get, root / "output", root / "slots", poll_seconds=0.02)

    def payload(self, count=5):
        return {
            "batch_id": "sim-batch",
            "name": "模拟批次",
            "concurrency": 3,
            "output_dir": str(self.root / "output"),
            "items": [{"id": f"task-{i}", "prompt": f"A quiet blue scene {i}", "aspect": "16:9"} for i in range(count)],
        }

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / "output").mkdir()

    def tearDown(self):
        self.temp.cleanup()

    def test_validation_points_to_item_and_caps_concurrency(self):
        result = validate_payload({"batch_id": "bad", "concurrency": 4, "items": [{"id": "same", "prompt": ""}, {"id": "same", "prompt": "ok"}]}, self.root / "output")
        self.assertFalse(result["ok"])
        self.assertTrue(any(error["field"] == "concurrency" for error in result["errors"]))
        self.assertTrue(any(error.get("item") == "same" for error in result["errors"]))

    def test_success_auto_fills_three_slots(self):
        adapter = FakeAdapter(self.root / "output")
        manager = self.make_manager(self.root, adapter)
        state = manager.create(self.payload(6))
        manager.start(state["batchId"], True)
        self.assertTrue(wait_until(lambda: manager.get_state("sim-batch")["status"] == "completed"))
        final = manager.get_state("sim-batch")
        self.assertEqual(len(adapter.submitted), 6)
        self.assertTrue(all(item["status"] == "completed" for item in final["items"]))

    def test_failure_pauses_without_retry(self):
        adapter = FakeAdapter(self.root / "output", fail_ids={"task-1"})
        manager = self.make_manager(self.root, adapter)
        manager.create(self.payload(4))
        manager.start("sim-batch", True)
        self.assertTrue(wait_until(lambda: manager.get_state("sim-batch")["status"] == "paused"))
        state = manager.get_state("sim-batch")
        self.assertEqual(state["items"][1]["status"], "failed")
        count = len(adapter.submitted)
        time.sleep(0.12)
        self.assertEqual(len(adapter.submitted), count)


    def test_login_required_pauses_and_only_resumes_after_slot_verification(self):
        adapter = FakeAdapter(self.root / "output", login_ids={"task-0"})
        slot_login = {"ready": False, "checked": []}
        manager = BatchManager(
            self.root / "batches", adapter.submit, adapter.get, self.root / "output", self.root / "slots",
            poll_seconds=0.02,
            slot_login_ready=lambda item: slot_login["checked"].append((item["batchId"], item["slot"], item["profile"])) or slot_login["ready"],
        )
        manager.create(self.payload(3))
        manager.start("sim-batch", True)
        self.assertTrue(wait_until(lambda: manager.get_state("sim-batch")["status"] == "paused" and all(item["status"] != "running" for item in manager.get_state("sim-batch")["items"])))
        paused = manager.get_state("sim-batch")
        login_item = next(item for item in paused["items"] if item["id"] == "task-0")
        self.assertEqual(login_item["status"], "login_required")
        self.assertFalse(login_item["lastResult"]["submitted"])
        self.assertIn("slot-", login_item["profile"])
        submitted_before = len(adapter.submitted)
        time.sleep(0.08)
        self.assertEqual(len(adapter.submitted), submitted_before)
        with self.assertRaises(BatchError):
            manager.resume("sim-batch", False)
        with self.assertRaises(BatchError):
            manager.resume("sim-batch", True)
        self.assertEqual(len(adapter.submitted), submitted_before)
        slot_login["ready"] = True
        adapter.login_ids.clear()
        manager.resume("sim-batch", True)
        self.assertTrue(wait_until(lambda: manager.get_state("sim-batch")["status"] == "completed"))
        final = manager.get_state("sim-batch")
        self.assertEqual(len(adapter.submitted), 4)
        self.assertEqual(final["items"][0]["loginCheckJobId"], "fake-task-0-1")
        self.assertEqual(final["items"][0]["status"], "completed")
        self.assertTrue(all(entry[0] == "sim-batch" for entry in slot_login["checked"]))

    def test_restart_does_not_resubmit_completed_items(self):
        adapter = FakeAdapter(self.root / "output")
        manager = self.make_manager(self.root, adapter)
        manager.create(self.payload(2))
        manager.start("sim-batch", True)
        self.assertTrue(wait_until(lambda: manager.get_state("sim-batch")["status"] == "completed"))
        count = len(adapter.submitted)
        manager2 = self.make_manager(self.root, adapter)
        time.sleep(0.08)
        self.assertEqual(len(adapter.submitted), count)
        self.assertEqual(manager2.get_state("sim-batch")["status"], "completed")


if __name__ == "__main__":
    unittest.main()
