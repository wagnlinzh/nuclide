/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 *
 * @flow
 * @format
 */

import type {NuclideUri} from '../../commons-node/nuclideUri';
import type {
  FileOpenEvent,
  FileCloseEvent,
  FileEditEvent,
  FileEvent,
  FileVersion,
  LocalFileEvent,
} from './rpc-types';

import TextBuffer from 'simple-text-buffer';
import invariant from 'assert';
import {BehaviorSubject, Subject, Observable} from 'rxjs';
import {FileVersionNotifier} from './FileVersionNotifier';
import UniversalDisposable from '../../commons-node/UniversalDisposable';
import nuclideUri from '../../commons-node/nuclideUri';

import {FileEventKind} from './constants';

export class FileCache {
  _buffers: Map<NuclideUri, simpleTextBuffer$TextBuffer>;
  _requests: FileVersionNotifier;
  _fileEvents: Subject<LocalFileEvent>;
  // Care! update() is the only way you're allowed to update _buffers
  // or to fire a _fileEvents.next() event. That's to ensure that the three things
  // stay in sync.
  _directoryEvents: BehaviorSubject<Set<NuclideUri>>;
  _resources: UniversalDisposable;

  constructor() {
    this._buffers = new Map();
    this._fileEvents = new Subject();
    this._directoryEvents = new BehaviorSubject(new Set());
    this._requests = new FileVersionNotifier();

    this._resources = new UniversalDisposable();
    this._resources.add(this._requests);
    this._resources.add(
      this._fileEvents.subscribe(event => {
        this._requests.onEvent(event);
      }),
    );
  }

  update(updateBufferAndMakeEventFunc: () => LocalFileEvent) {
    const event = updateBufferAndMakeEventFunc();
    this._fileEvents.next(event);
  }

  // If any out of sync state is detected then an Error is thrown.
  // This will force the client to send a 'sync' event to get back on track.
  onFileEvent(event: FileEvent): Promise<void> {
    const filePath = event.fileVersion.filePath;
    const changeCount = event.fileVersion.version;
    const buffer = this._buffers.get(filePath);
    switch (event.kind) {
      case FileEventKind.OPEN:
        invariant(buffer == null);
        this._open(filePath, event.contents, changeCount);
        break;
      case FileEventKind.CLOSE:
        if (buffer != null) {
          this._close(filePath, buffer);
        }
        break;
      case FileEventKind.EDIT:
        invariant(buffer != null);
        invariant(buffer.changeCount === changeCount - 1);
        invariant(buffer.getTextInRange(event.oldRange) === event.oldText);
        this.update(() => {
          buffer.setTextInRange(event.oldRange, event.newText);
          invariant(buffer.changeCount === changeCount);
          return event;
        });
        break;
      case FileEventKind.SYNC:
        if (buffer == null) {
          this._open(filePath, event.contents, changeCount);
        } else {
          this._syncEdit(filePath, buffer, event.contents, changeCount);
        }
        break;
      default:
        throw new Error(`Unexpected FileEvent.kind: ${event.kind}`);
    }
    return Promise.resolve(undefined);
  }

  async onDirectoriesChanged(openDirectories: Set<NuclideUri>): Promise<void> {
    this._directoryEvents.next(openDirectories);
  }

  _syncEdit(
    filePath: NuclideUri,
    buffer: simpleTextBuffer$TextBuffer,
    contents: string,
    changeCount: number,
  ): void {
    // messages are out of order
    if (changeCount < buffer.changeCount) {
      return;
    }

    const oldText = buffer.getText();
    const oldRange = buffer.getRange();
    this.update(() => {
      buffer.setText(contents);
      const newRange = buffer.getRange();
      buffer.changeCount = changeCount;
      return createEditEvent(
        this.createFileVersion(filePath, changeCount),
        oldRange,
        oldText,
        newRange,
        buffer.getText(),
      );
    });
  }

  _open(filePath: NuclideUri, contents: string, changeCount: number): void {
    // We never call setPath on these TextBuffers as that will
    // start the TextBuffer attempting to sync with the file system.
    const newBuffer = new TextBuffer(contents);
    newBuffer.changeCount = changeCount;
    this.update(() => {
      this._buffers.set(filePath, newBuffer);
      return createOpenEvent(
        this.createFileVersion(filePath, changeCount),
        contents,
      );
    });
  }

  _close(filePath: NuclideUri, buffer: simpleTextBuffer$TextBuffer): void {
    this.update(() => {
      this._buffers.delete(filePath);
      return createCloseEvent(
        this.createFileVersion(filePath, buffer.changeCount),
      );
    });
    buffer.destroy();
  }

  dispose(): void {
    // The _close routine will delete elements from the _buffers map.
    // Per ES6 this is safe to do even while iterating.
    for (const [filePath, buffer] of this._buffers.entries()) {
      this._close(filePath, buffer);
    }
    invariant(this._buffers.size === 0);
    this._resources.dispose();
    this._fileEvents.complete();
    this._directoryEvents.complete();
  }

  getBuffer(filePath: NuclideUri): ?simpleTextBuffer$TextBuffer {
    // TODO: change this to return a string, to ensure that no caller will ever mutate
    // the buffer contents (and hence its changeCount). The only modifications allowed
    // are those that come from the editor inside this.onFileEvent.
    return this._buffers.get(filePath);
  }

  async getBufferAtVersion(
    fileVersion: FileVersion,
  ): Promise<?simpleTextBuffer$TextBuffer> {
    // TODO: change this to return a string, like getBuffer() above.
    if (!await this._requests.waitForBufferAtVersion(fileVersion)) {
      return null;
    }
    const buffer = this.getBuffer(fileVersion.filePath);
    return buffer != null && buffer.changeCount === fileVersion.version
      ? buffer
      : null;
  }

  // _tryGetBufferAtVersionSynchronously - a synchronous version of getBufferAtVersion above
  _tryGetBufferAtVersionSynchronously(
    fileVersion: FileVersion,
  ): ?simpleTextBuffer$TextBuffer {
    // TODO: change this to return a string, like getBuffer() above.
    if (!this._requests.isBufferAtVersion(fileVersion)) {
      return null;
    }
    const buffer = this.getBuffer(fileVersion.filePath);
    return buffer != null && buffer.changeCount === fileVersion.version
      ? buffer
      : null;
  }

  getOpenDirectories(): Set<NuclideUri> {
    return this._directoryEvents.getValue();
  }

  // Returns directory which contains this path if any.
  // Remote equivalent of atom.project.relativizePath()[1]
  // TODO: Return the most nested open directory.
  //       Note that Atom doesn't do this, though it should.
  getContainingDirectory(filePath: NuclideUri): ?NuclideUri {
    for (const dir of this.getOpenDirectories()) {
      if (nuclideUri.contains(dir, filePath)) {
        return dir;
      }
    }
    return null;
  }

  getOpenFiles(): Iterator<NuclideUri> {
    return this._buffers.keys();
  }

  observeFileEvents(): Observable<LocalFileEvent> {
    return Observable.from(
      Array.from(this._buffers.entries()).map(([filePath, buffer]) => {
        invariant(buffer != null);
        return createOpenEvent(
          this.createFileVersion(filePath, buffer.changeCount),
          buffer.getText(),
        );
      }),
    ).concat(this._fileEvents);
  }

  observeDirectoryEvents(): Observable<Set<NuclideUri>> {
    return this._directoryEvents;
  }

  createFileVersion(filePath: NuclideUri, version: number): FileVersion {
    return {
      notifier: this,
      filePath,
      version,
    };
  }
}

function createOpenEvent(
  fileVersion: FileVersion,
  contents: string,
): FileOpenEvent {
  return {
    kind: FileEventKind.OPEN,
    fileVersion,
    contents,
  };
}

function createCloseEvent(fileVersion: FileVersion): FileCloseEvent {
  return {
    kind: FileEventKind.CLOSE,
    fileVersion,
  };
}

function createEditEvent(
  fileVersion: FileVersion,
  oldRange: atom$Range,
  oldText: string,
  newRange: atom$Range,
  newText: string,
): FileEditEvent {
  return {
    kind: FileEventKind.EDIT,
    fileVersion,
    oldRange,
    oldText,
    newRange,
    newText,
  };
}
