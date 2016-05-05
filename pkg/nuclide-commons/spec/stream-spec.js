'use babel';
/* @flow */

/*
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 */

import {diffSets, cacheWhileSubscribed, reconcileSetDiffs, observeStream, splitStream} from '..';
import {Disposable} from 'event-kit';
import {Observable, Subject} from 'rxjs';
import Stream from 'stream';

const setsAreEqual = (a, b) => a.size === b.size && Array.from(a).every(b.has.bind(b));
const diffsAreEqual = (a, b) => (
  setsAreEqual(a.added, b.added) && setsAreEqual(a.removed, b.removed)
);
const createDisposable = () => {
  const disposable = new Disposable(() => {});
  spyOn(disposable, 'dispose');
  return disposable;
};

describe('nuclide-commons/stream', () => {

  it('splitStream', () => {
    waitsForPromise(async () => {
      const input = ['foo\nbar', '\n', '\nba', 'z', '\nblar'];
      const output = await splitStream(Observable.from(input)).toArray().toPromise();
      expect(output).toEqual(['foo\n', 'bar\n', '\n', 'baz\n', 'blar']);
    });
  });

  it('observeStream', () => {
    waitsForPromise(async () => {
      const input = ['foo\nbar', '\n', '\nba', 'z', '\nblar'];
      const stream = new Stream.PassThrough();
      const promise = observeStream(stream).toArray().toPromise();
      input.forEach(value => { stream.write(value, 'utf8'); });
      stream.end();
      const output = await promise;
      expect(output.join('')).toEqual(input.join(''));
    });
  });

  it('observeStream - error', () => {
    waitsForPromise(async () => {
      const stream = new Stream.PassThrough();
      const input = ['foo\nbar', '\n', '\nba', 'z', '\nblar'];
      const output = [];
      const promise = new Promise((resolve, reject) => {
        observeStream(stream).subscribe(
          v => output.push(v),
          e => resolve(e),
          () => {}
        );
      });
      const error = new Error('Had an error');

      input.forEach(value => { stream.write(value, 'utf8'); });
      stream.emit('error', error);

      const result = await promise;
      expect(output).toEqual(input);
      expect(result).toBe(error);
    });
  });
});

describe('cacheWhileSubscribed', () => {
  let input: Subject<number> = (null: any);
  let output: Observable<number> = (null: any);

  function subscribeArray(arr: Array<number>): rx$ISubscription {
    return output.subscribe(x => arr.push(x));
  }
  beforeEach(() => {
    input = new Subject();
    output = cacheWhileSubscribed(input);
  });

  it('should provide cached values to late subscribers', () => {
    const arr1 = [];
    const arr2 = [];

    input.next(0);
    const sub1 = subscribeArray(arr1);
    input.next(1);
    input.next(2);
    const sub2 = subscribeArray(arr2);

    sub1.unsubscribe();
    sub2.unsubscribe();
    expect(arr1).toEqual([1, 2]);
    expect(arr2).toEqual([2]);
  });

  it('should not store stale events when everyone is unsubscribed', () => {
    const arr1 = [];
    const arr2 = [];

    input.next(0);
    const sub1 = subscribeArray(arr1);
    input.next(1);
    sub1.unsubscribe();

    input.next(2);

    const sub2 = subscribeArray(arr2);
    input.next(3);
    sub2.unsubscribe();

    expect(arr1).toEqual([1]);
    expect(arr2).toEqual([3]);
  });

});

describe('diffSets', () => {

  it('emits a diff for the first item', () => {
    waitsForPromise(async () => {
      const source = new Subject();
      const diffsPromise = diffSets(source).toArray().toPromise();
      source.next(new Set([1, 2, 3]));
      source.complete();
      const diffs = await diffsPromise;
      expect(diffs.length).toBe(1);
      expect(diffsAreEqual(diffs[0], {
        added: new Set([1, 2, 3]),
        removed: new Set(),
      })).toBe(true);
    });
  });

  it('correctly identifies removed items', () => {
    waitsForPromise(async () => {
      const source = new Subject();
      const diffsPromise = diffSets(source).toArray().toPromise();
      source.next(new Set([1, 2, 3]));
      source.next(new Set([1, 2]));
      source.complete();
      const diffs = await diffsPromise;
      expect(setsAreEqual(diffs[1].removed, new Set([3]))).toBe(true);
    });
  });

  it('correctly identifies added items', () => {
    waitsForPromise(async () => {
      const source = new Subject();
      const diffsPromise = diffSets(source).toArray().toPromise();
      source.next(new Set([1, 2]));
      source.next(new Set([1, 2, 3]));
      source.complete();
      const diffs = await diffsPromise;
      expect(setsAreEqual(diffs[1].added, new Set([3]))).toBe(true);
    });
  });

  it("doesn't emit a diff when nothing changes", () => {
    waitsForPromise(async () => {
      const source = new Subject();
      const diffsPromise = diffSets(source).toArray().toPromise();
      source.next(new Set([1, 2, 3]));
      source.next(new Set([1, 2, 3]));
      source.complete();
      const diffs = await diffsPromise;
      // Make sure we only get one diff (from the implicit initial empty set).
      expect(diffs.length).toBe(1);
    });
  });

});

describe('reconcileSetDiffs', () => {

  it("calls the add action for each item that's added", () => {
    const diffs = new Subject();
    const addAction = jasmine.createSpy().andReturn(new Disposable(() => {}));
    reconcileSetDiffs(diffs, addAction);
    diffs.next({
      added: new Set(['a', 'b']),
      removed: new Set(),
    });
    expect(addAction.calls.map(call => call.args[0])).toEqual(['a', 'b']);
  });

  it("disposes for each item that's removed", () => {
    const diffs = new Subject();
    const disposables = {
      a: createDisposable(),
      b: createDisposable(),
    };
    const addAction = item => disposables[item];
    reconcileSetDiffs(diffs, addAction);
    diffs.next({
      added: new Set(['a', 'b']),
      removed: new Set(),
    });
    diffs.next({
      added: new Set(),
      removed: new Set(['a', 'b']),
    });
    expect(disposables.a.dispose).toHaveBeenCalled();
    expect(disposables.b.dispose).toHaveBeenCalled();
  });

  it('disposes for all items when disposed', () => {
    const diffs = new Subject();
    const disposables = {
      a: createDisposable(),
      b: createDisposable(),
    };
    const addAction = item => disposables[item];
    const reconciliationDisposable = reconcileSetDiffs(diffs, addAction);
    diffs.next({
      added: new Set(['a', 'b']),
      removed: new Set(),
    });
    reconciliationDisposable.dispose();
    expect(disposables.a.dispose).toHaveBeenCalled();
    expect(disposables.b.dispose).toHaveBeenCalled();
  });

});
