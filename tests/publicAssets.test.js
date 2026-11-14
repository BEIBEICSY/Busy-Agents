import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('public dashboard assets exist with expected anchors', () => {
  const html = fs.readFileSync('public/index.html', 'utf8');
  const css = fs.readFileSync('public/styles.css', 'utf8');
  const js = fs.readFileSync('public/app.js', 'utf8');

  assert.match(html, /Agents 在忙啥/);
  assert.match(js, /Agents 在忙啥/);
  assert.match(html, /id="sessionRows"/);
  assert.match(html, /id="overviewPage"/);
  assert.match(html, /id="allPage"/);
  assert.match(html, /id="backButton"/);
  assert.match(html, /id="allTasksSubtitle"/);
  assert.match(html, /最近 7 天，共 0 任务/);
  assert.match(js, /最近 7 天，共 \$\{sessions\.length\} 任务/);
  assert.doesNotMatch(html, /id="searchInput"|id="moreFilter"|id="syncLabel"/);
  assert.match(css, /\.status\.needs_response/);
  assert.match(css, /\.status\.completed_unseen/);
  assert.match(css, /\.status\.ended_abnormally/);
  assert.match(html, /待查看/);
  assert.match(html, /id="connectionNotice"/);
  assert.match(js, /\/api\/sessions/);
  assert.match(html, /id="taskFeedbackMenu"/);
  assert.match(html, /这条数据不对我要反馈/);
  assert.match(js, /\/api\/session-diagnostic/);
  assert.match(js, /https:\/\/f\.kdocs\.cn\/g\/h09CF9me\//);
  assert.match(js, /\/api\/data-roots/);
});
