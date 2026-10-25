import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { junit, xray } from '../commands/import.ts';
import { findJunitCreations, findXrayJsonCreations, guardMessage } from './import-guard.ts';

/** The shape Playwright 1.60's junit reporter writes (properties as open/close pairs). */
const KEYED = `<testsuites id="" name="" tests="1" failures="0" skipped="0" errors="0" time="1">
<testsuite name="login.test.ts" timestamp="2026-01-01T00:00:00.000Z" hostname="e2e" tests="1" failures="0" skipped="0" time="1" errors="0">
<properties>
<property name="ci" value="true">
</property>
</properties>
<testcase name="logs in" classname="login.test.ts" time="1">
<properties>
<property name="test_key" value="DEMO-7101">
</property>
</properties>
<system-out>
<![CDATA[<testcase name="inside cdata">]]>
</system-out>
</testcase>
</testsuite>
</testsuites>`;

const UNKEYED = `<testsuites>
<testsuite name="login.test.ts" hostname="e2e">
<testcase name="logs in" classname="login.test.ts" time="1">
<properties>
<property name="test_key" value="DEMO-7101"/>
</properties>
</testcase>
<testcase name="shows the banner" classname="login.test.ts" time="1">
<properties>
<property name="atc" value="DEMO-7102">
</property>
</properties>
</testcase>
</testsuite>
<testsuite name="global.setup.ts" hostname="global-setup">
<testcase name="create directories" classname="global.setup.ts" time="0"/>
</testsuite>
</testsuites>`;

describe('findJunitCreations', () => {
  test('a testcase with a test_key passes, suite-level properties and CDATA ignored', () => {
    expect(findJunitCreations(KEYED)).toEqual([]);
  });

  test('a testcase without a key is named, self-closing setup testcases included', () => {
    expect(findJunitCreations(UNKEYED)).toEqual([
      { where: 'login.test.ts > shows the banner', reason: 'no test_key or test_id property' },
      { where: 'global.setup.ts > create directories', reason: 'no test_key or test_id property' },
    ]);
  });

  test('test_id counts as a key; two values of the same key are refused', () => {
    const xml = `<testsuite name="s">
<testcase name="by id"><properties><property name="test_id" value="10001"/></properties></testcase>
<testcase name="both"><properties><property name="test_id" value="10001"/><property name="test_key" value="DEMO-7103"/></properties></testcase>
<testcase name="two"><properties><property name="test_key" value="DEMO-7104"/><property name="test_key" value="DEMO-7105"/></properties></testcase>
<testcase name="empty"><properties><property name="test_key" value=" "/></properties></testcase>
</testsuite>`;
    expect(findJunitCreations(xml)).toEqual([
      { where: 's > two', reason: 'more than one key (DEMO-7104, DEMO-7105)' },
      { where: 's > empty', reason: 'no test_key or test_id property' },
    ]);
  });
});

describe('findXrayJsonCreations', () => {
  test('testKey entries pass; testInfo or a missing key is refused', () => {
    expect(findXrayJsonCreations({ testExecutionKey: 'DEMO-7150', tests: [{ testKey: 'DEMO-7101', status: 'PASSED' }] })).toEqual([]);
    expect(findXrayJsonCreations({
      tests: [
        { testKey: 'DEMO-7101', status: 'PASSED', testInfo: { summary: 's', projectKey: 'DEMO', type: 'Generic' } },
        { status: 'FAILED' },
      ],
    })).toEqual([
      { where: 'tests[0]', reason: 'carries testInfo' },
      { where: 'tests[1]', reason: 'no testKey' },
    ]);
  });
});

describe('import commands refuse before any network call', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xray-guard-'));

  test('import junit names every testcase without a key in one message', async () => {
    const file = join(dir, 'junit.xml');
    writeFileSync(file, UNKEYED);
    const error = await junit({ file, execution: 'DEMO-7150' }).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(guardMessage(file, findJunitCreations(UNKEYED)));
    expect((error as Error).message).toContain('login.test.ts > shows the banner (no test_key or test_id property); global.setup.ts > create directories');
  });

  test('import xray refuses an entry with testInfo', async () => {
    const file = join(dir, 'results.json');
    writeFileSync(file, JSON.stringify({ tests: [{ status: 'PASSED', testInfo: { summary: 's', projectKey: 'DEMO', type: 'Generic' } }] }));
    const error = await xray({ file }).catch((e: Error) => e);
    expect((error as Error).message).toContain('tests[0] (carries testInfo)');
  });
});
