#!/usr/bin/env python3
import importlib.util
from pathlib import Path
import time
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('collector',Path(__file__).resolve().parents[1]/'deploy/app-metrics/collector.py')
collector=importlib.util.module_from_spec(spec);spec.loader.exec_module(collector)
class CollectorTests(unittest.TestCase):
    def snapshot(self):
        return {'schema':1,'generated_at':time.time()*1000,'metrics':[
            {'name':'app_database_up','value':1},{'name':'app_http_requests_per_min','value':10},{'name':'app_process_uptime_seconds','value':15}]}
    def test_schema_values_and_freshness(self):
        self.assertEqual(collector.validate(self.snapshot(),time.time())['app_http_requests_per_min'],10)
        for value in (float('nan'),float('inf'),-1,True,'10'):
            snapshot=self.snapshot();snapshot['metrics'][0]['value']=value
            with self.assertRaises(ValueError):collector.validate(snapshot,time.time())
        snapshot=self.snapshot();snapshot['generated_at']-=60000
        with self.assertRaises(ValueError):collector.validate(snapshot,time.time())
        for name in ('user_private_name','app_up'):
            snapshot=self.snapshot();snapshot['metrics'][0]['name']=name
            with self.assertRaises(ValueError):collector.validate(snapshot,time.time())
    def test_outage_omits_old_values_instead_of_fabricating_zeroes(self):
        with patch.object(collector,'get_json',side_effect=OSError):
            self.assertEqual(collector.collect(),{'app_collector_up':1,'app_up':0,'app_metrics_up':0})
    def test_shell_free_export_targets_existing_host_and_expiry(self):
        with patch.object(collector.subprocess,'run') as run:
            collector.publish({'app_up':1})
            args=run.call_args.args[0]
            self.assertIn('--spoof=127.0.0.1:fantasytales-server',args)
            self.assertIn('--dmax=120',args)
            self.assertNotIn('shell',run.call_args.kwargs)
unittest.main()
