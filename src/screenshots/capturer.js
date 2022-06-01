import {
    join as joinPath,
    dirname,
    basename,
} from 'path';

import { generateThumbnail } from 'testcafe-browser-tools';
import { cropScreenshot } from './crop';
import { isInQueue, addToQueue } from '../utils/async-queue';
import WARNING_MESSAGE from '../notifications/warning-message';
import escapeUserAgent from '../utils/escape-user-agent';
import correctFilePath from '../utils/correct-file-path';
import {
    readFile,
    readPngFile,
    stat,
    writeFile,
    writePng,
} from '../utils/promisified-functions';

import DEFAULT_SCREENSHOT_EXTENSION from './default-extension';
import makeDir from 'make-dir';


export default class Capturer {
    // TODO: refactor to use dictionary
    constructor (baseScreenshotsPath, testEntry, connection, pathPattern, fullPage, thumbnails, warningLog, tempDirectoryPath, autoTakeOnFails) {
        this.enabled             = !!baseScreenshotsPath;
        this.baseScreenshotsPath = baseScreenshotsPath;
        this.testEntry           = testEntry;
        this.provider            = connection.provider;
        this.browserId           = connection.id;
        this.warningLog          = warningLog;
        this.pathPattern         = pathPattern;
        this.fullPage            = fullPage;
        this.thumbnails          = thumbnails;
        this.tempDirectoryPath   = tempDirectoryPath;
        this.autoTakeOnFails     = autoTakeOnFails;
    }

    static _getDimensionWithoutScrollbar (fullDimension, documentDimension, bodyDimension) {
        if (bodyDimension > fullDimension)
            return documentDimension;

        if (documentDimension > fullDimension)
            return bodyDimension;

        return Math.max(documentDimension, bodyDimension);
    }

    static _getCropDimensions (cropDimensions, pageDimensions) {
        if (!cropDimensions || !pageDimensions)
            return null;

        const { dpr }                      = pageDimensions;
        const { top, left, bottom, right } = cropDimensions;

        return {
            top:    Math.round(top * dpr),
            left:   Math.round(left * dpr),
            bottom: Math.round(bottom * dpr),
            right:  Math.round(right * dpr),
        };
    }

    static _getClientAreaDimensions (pageDimensions) {
        if (!pageDimensions)
            return null;

        const { innerWidth, documentWidth, bodyWidth, innerHeight, documentHeight, bodyHeight, dpr } = pageDimensions;

        return {
            width:  Math.floor(Capturer._getDimensionWithoutScrollbar(innerWidth, documentWidth, bodyWidth) * dpr),
            height: Math.floor(Capturer._getDimensionWithoutScrollbar(innerHeight, documentHeight, bodyHeight) * dpr),
        };
    }

    static async _isScreenshotCaptured (screenshotPath) {
        try {
            const stats = await stat(screenshotPath);

            return stats.isFile();
        }
        catch (e) {
            return false;
        }
    }

    _joinWithBaseScreenshotPath (path) {
        return joinPath(this.baseScreenshotsPath, path);
    }

    _incrementFileIndexes (forError) {
        if (forError)
            this.pathPattern.data.errorFileIndex++;

        else
            this.pathPattern.data.fileIndex++;
    }

    _getCustomScreenshotPath (customPath) {
        const correctedCustomPath = correctFilePath(customPath, DEFAULT_SCREENSHOT_EXTENSION);

        return this._joinWithBaseScreenshotPath(correctedCustomPath);
    }

    _getScreenshotPath (forError) {
        const path = this.pathPattern.getPath(forError);

        this._incrementFileIndexes(forError);

        return this._joinWithBaseScreenshotPath(path);
    }

    _getThumbnailPath (screenshotPath) {
        const imageName = basename(screenshotPath);
        const imageDir  = dirname(screenshotPath);

        return joinPath(imageDir, 'thumbnails', imageName);
    }

    async _takeScreenshot ({ filePath, pageWidth, pageHeight, fullPage = this.fullPage }) {
        await this.provider.takeScreenshot(this.browserId, filePath, pageWidth, pageHeight, fullPage);
    }

    async _capture (forError, { pageDimensions, cropDimensions, markSeed, customPath, fullPage, thumbnails } = {}) {
        if (!this.enabled)
            return null;

        thumbnails = thumbnails === void 0 ? this.thumbnails : thumbnails;

        const screenshotPath = customPath ? this._getCustomScreenshotPath(customPath) : this._getScreenshotPath(forError);
        const thumbnailPath  = this._getThumbnailPath(screenshotPath);
        const tempPath       = screenshotPath.replace(this.baseScreenshotsPath, this.tempDirectoryPath);
        let screenshotData;

        if (isInQueue(screenshotPath))
            this.warningLog.addWarning(WARNING_MESSAGE.screenshotRewritingError, screenshotPath);

        await addToQueue(screenshotPath, async () => {
            const clientAreaDimensions = Capturer._getClientAreaDimensions(pageDimensions);

            const { width: pageWidth, height: pageHeight } = clientAreaDimensions || {};

            const takeScreenshotOptions = {
                filePath: tempPath,
                pageWidth,
                pageHeight,
                fullPage,
            };

            await this._takeScreenshot(takeScreenshotOptions);

            if (!await Capturer._isScreenshotCaptured(tempPath))
                return;

            const image = await readPngFile(tempPath);

            const croppedImage = await cropScreenshot(image, {
                markSeed,
                clientAreaDimensions,
                path:           tempPath,
                cropDimensions: Capturer._getCropDimensions(cropDimensions, pageDimensions),
            });

            if (croppedImage)
                await writePng(tempPath, croppedImage);

            screenshotData = await readFile(tempPath);

            if (forError && this.autoTakeOnFails)
                return;

            await makeDir(dirname(screenshotPath));
            await writeFile(screenshotPath, screenshotData);

            if (thumbnails)
                await generateThumbnail(screenshotPath, thumbnailPath);
        });

        const testRunId         = this.testEntry.testRuns[this.browserId].id;
        const userAgent         = escapeUserAgent(this.pathPattern.data.parsedUserAgent.prettyUserAgent);
        const quarantineAttempt = this.pathPattern.data.quarantineAttempt;
        const takenOnFail       = forError;

        const screenshot = {
            testRunId,
            screenshotPath,
            screenshotData,
            thumbnailPath,
            userAgent,
            quarantineAttempt,
            takenOnFail,
        };

        this.testEntry.screenshots.push(screenshot);

        return screenshotPath;
    }

    async captureAction (options) {
        return await this._capture(false, options);
    }

    async captureError (options) {
        return await this._capture(true, options);
    }
}

