/*! @license
 * Shaka Player
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

goog.provide('shaka.util.Mp4Parser');

goog.require('goog.asserts');
goog.require('shaka.log');
goog.require('shaka.util.DataViewReader');


/**
 * @export
 */
shaka.util.Mp4Parser = class {
  /** */
  constructor() {
    /** @private {!Object.<number, shaka.util.Mp4Parser.BoxType_>} */
    this.headers_ = [];

    /** @private {!Object.<number, !shaka.util.Mp4Parser.CallbackType>} */
    this.boxDefinitions_ = [];

    /** @private {boolean} */
    this.done_ = false;
  }


  /**
   * Declare a box type as a Box.
   *
   * @param {string} type
   * @param {!shaka.util.Mp4Parser.CallbackType} definition
   * @return {!shaka.util.Mp4Parser}
   * @export
   */
  box(type, definition) {
    const typeCode = shaka.util.Mp4Parser.typeFromString_(type);
    this.headers_[typeCode] = shaka.util.Mp4Parser.BoxType_.BASIC_BOX;
    this.boxDefinitions_[typeCode] = definition;
    return this;
  }


  /**
   * Declare a box type as a Full Box.
   *
   * @param {string} type
   * @param {!shaka.util.Mp4Parser.CallbackType} definition
   * @return {!shaka.util.Mp4Parser}
   * @export
   */
  fullBox(type, definition) {
    const typeCode = shaka.util.Mp4Parser.typeFromString_(type);
    this.headers_[typeCode] = shaka.util.Mp4Parser.BoxType_.FULL_BOX;
    this.boxDefinitions_[typeCode] = definition;
    return this;
  }


  /**
   * Stop parsing.  Useful for extracting information from partial segments and
   * avoiding an out-of-bounds error once you find what you are looking for.
   *
   * @export
   */
  stop() {
    this.done_ = true;
  }


  /**
   * Parse the given data using the added callbacks.
   *
   * @param {!BufferSource} data
   * @param {boolean=} partialOkay If true, allow reading partial payloads
   *   from some boxes. If the goal is a child box, we can sometimes find it
   *   without enough data to find all child boxes.
   * @param {boolean=} stopOnPartial If true, stop reading if an incomplete
   *   box is detected.
   * @export
   */
  parse(data, partialOkay, stopOnPartial) {
    const reader = new shaka.util.DataViewReader(
        data, shaka.util.DataViewReader.Endianness.BIG_ENDIAN);

    this.done_ = false;
    while (reader.hasMoreData() && !this.done_) {
      this.parseNext(0, reader, partialOkay, stopOnPartial);
    }
  }


  /**
   * Parse the next box on the current level.
   *
   * @param {number} absStart The absolute start position in the original
   *   byte array.
   * @param {!shaka.util.DataViewReader} reader
   * @param {boolean=} partialOkay If true, allow reading partial payloads
   *   from some boxes. If the goal is a child box, we can sometimes find it
   *   without enough data to find all child boxes.
   * @param {boolean=} stopOnPartial If true, stop reading if an incomplete
   *   box is detected.
   * @export
   */
  parseNext(absStart, reader, partialOkay, stopOnPartial) {
    const start = reader.getPosition();

    // size(4 bytes) + type(4 bytes) = 8 bytes
    if (stopOnPartial && start + 8 > reader.getLength()) {
      this.done_ = true;
      return;
    }

    let size = reader.readUint32();
    const type = reader.readUint32();
    const name = shaka.util.Mp4Parser.typeToString(type);
    let has64BitSize = false;
    shaka.log.v2('Parsing MP4 box', name);

    switch (size) {
      case 0:
        size = reader.getLength() - start;
        break;
      case 1:
        if (stopOnPartial && reader.getPosition() + 8 > reader.getLength()) {
          this.done_ = true;
          return;
        }
        size = reader.readUint64();
        has64BitSize = true;
        break;
    }

    const boxDefinition = this.boxDefinitions_[type];

    if (boxDefinition) {
      let version = null;
      let flags = null;

      if (this.headers_[type] == shaka.util.Mp4Parser.BoxType_.FULL_BOX) {
        if (stopOnPartial && reader.getPosition() + 4 > reader.getLength()) {
          this.done_ = true;
          return;
        }
        const versionAndFlags = reader.readUint32();
        version = versionAndFlags >>> 24;
        flags = versionAndFlags & 0xFFFFFF;
      }

      // Read the whole payload so that the current level can be safely read
      // regardless of how the payload is parsed.
      let end = start + size;
      if (partialOkay && end > reader.getLength()) {
        // For partial reads, truncate the payload if we must.
        end = reader.getLength();
      }

      if (stopOnPartial && end > reader.getLength()) {
        this.done_ = true;
        return;
      }
      const payloadSize = end - reader.getPosition();
      const payload =
      (payloadSize > 0) ? reader.readBytes(payloadSize) : new Uint8Array(0);

      const payloadReader = new shaka.util.DataViewReader(
          payload, shaka.util.DataViewReader.Endianness.BIG_ENDIAN);

      /** @type {shaka.extern.ParsedBox} */
      const box = {
        parser: this,
        partialOkay: partialOkay || false,
        version,
        flags,
        reader: payloadReader,
        size,
        start: start + absStart,
        has64BitSize,
      };

      boxDefinition(box);
    } else {
      // Move the read head to be at the end of the box.
      // If the box is longer than the remaining parts of the file, e.g. the
      // mp4 is improperly formatted, or this was a partial range request that
      // ended in the middle of a box, just skip to the end.
      const skipLength = Math.min(
          start + size - reader.getPosition(),
          reader.getLength() - reader.getPosition());
      reader.skip(skipLength);
    }
  }


  /**
   * A callback that tells the Mp4 parser to treat the body of a box as a series
   * of boxes. The number of boxes is limited by the size of the parent box.
   *
   * @param {!shaka.extern.ParsedBox} box
   * @export
   */
  static children(box) {
    // The "reader" starts at the payload, so we need to add the header to the
    // start position.  The header size varies.
    const headerSize = shaka.util.Mp4Parser.headerSize(box);
    while (box.reader.hasMoreData() && !box.parser.done_) {
      box.parser.parseNext(box.start + headerSize, box.reader, box.partialOkay);
    }
  }


  /**
   * A callback that tells the Mp4 parser to treat the body of a box as a sample
   * description. A sample description box has a fixed number of children. The
   * number of children is represented by a 4 byte unsigned integer. Each child
   * is a box.
   *
   * @param {!shaka.extern.ParsedBox} box
   * @export
   */
  static sampleDescription(box) {
    // The "reader" starts at the payload, so we need to add the header to the
    // start position.  The header size varies.
    const headerSize = shaka.util.Mp4Parser.headerSize(box);
    const count = box.reader.readUint32();
    for (let i = 0; i < count; i++) {
      box.parser.parseNext(box.start + headerSize, box.reader, box.partialOkay);
      if (box.parser.done_) {
        break;
      }
    }
  }


  /**
   * Create a callback that tells the Mp4 parser to treat the body of a box as a
   * binary blob and to parse the body's contents using the provided callback.
   *
   * @param {function(!Uint8Array)} callback
   * @return {!shaka.util.Mp4Parser.CallbackType}
   * @export
   */
  static allData(callback) {
    return (box) => {
      const all = box.reader.getLength() - box.reader.getPosition();
      callback(box.reader.readBytes(all));
    };
  }


  /**
   * Convert an ascii string name to the integer type for a box.
   *
   * @param {string} name The name of the box. The name must be four
   *                      characters long.
   * @return {number}
   * @private
   */
  static typeFromString_(name) {
    goog.asserts.assert(
        name.length == 4,
        'Mp4 box names must be 4 characters long');

    let code = 0;
    for (const chr of name) {
      code = (code << 8) | chr.charCodeAt(0);
    }
    return code;
  }


  /**
   * Convert an integer type from a box into an ascii string name.
   * Useful for debugging.
   *
   * @param {number} type The type of the box, a uint32.
   * @return {string}
   * @export
   */
  static typeToString(type) {
    const name = String.fromCharCode(
        (type >> 24) & 0xff,
        (type >> 16) & 0xff,
        (type >> 8) & 0xff,
        type & 0xff);
    return name;
  }

  /**
   * Find the header size of the box.
   * Useful for modifying boxes in place or finding the exact offset of a field.
   *
   * @param {shaka.extern.ParsedBox} box
   * @return {number}
   * @export
   */
  static headerSize(box) {
    const basicHeaderSize = 8;
    const _64BitFieldSize = box.has64BitSize ? 8 : 0;
    const versionAndFlagsSize = box.flags != null ? 4 : 0;
    return basicHeaderSize + _64BitFieldSize + versionAndFlagsSize;
  }
};


/**
 * @typedef {function(!shaka.extern.ParsedBox)}
 * @exportInterface
 */
shaka.util.Mp4Parser.CallbackType;


/**
 * An enum used to track the type of box so that the correct values can be
 * read from the header.
 *
 * @enum {number}
 * @private
 */
shaka.util.Mp4Parser.BoxType_ = {
  BASIC_BOX: 0,
  FULL_BOX: 1,
};


