import {
    Chapter,
    ChapterDetails,
    ContentRating,
    HomeSection,
    SourceManga,
    PartialSourceManga,
    MangaUpdates,
    PagedResults,
    Request,
    Response,
    SearchRequest,
    DUISection,
    Source,
    SourceInfo,
    SourceStateManager,
    TagSection,
    BadgeColor,
    SourceInterceptor,
    SourceIntents,
    MangaProgressProviding,
    MangaProgress,
    DUIForm,
    TrackerActionQueue,
} from '@paperback/types';
import { parseLangCode } from './Languages';
import { resetSettingsButton, serverSettingsMenu, testServerSettingsMenu } from './Settings';
import pMap from 'p-map';
import {
    getAuthorizationString,
    getKomgaAPI,
    getOptions,
    getServerUnavailableMangaTiles,
    searchRequest,
} from './Common';
// This source use Komga REST API
// https://komga.org/guides/rest.html
// Manga are represented by `series`
// Chapters are represented by `books`
// The Basic Authentication is handled by the interceptor
// Code and method used by both the source and the tracker are defined in the duplicated `KomgaCommon.ts` file
// Due to the self hosted nature of Komga, this source requires the user to enter its server credentials in the source settings menu
// Some methods are known to throw errors without specific actions from the user. They try to prevent this behavior when server settings are not set.
// This include:
//  - homepage sections
//  - getTags() which is called on the homepage
//  - search method which is called even if the user search in an other source
export const PaperbackInfo: SourceInfo = {
    version: '1.3.0',
    name: 'Paperback',
    icon: 'icon.png',
    author: 'Lemon | Faizan Durrani | Scherzo',
    authorWebsite: 'https://github.com/FramboisePi',
    description: 'Komga client extension for Paperback',
    contentRating: ContentRating.EVERYONE,
    websiteBaseURL: 'https://komga.org',
    sourceTags: [
        {
            text: 'Self hosted',
            type: BadgeColor.RED,
        },
    ],
    intents:
        SourceIntents.MANGA_CHAPTERS |
        SourceIntents.HOMEPAGE_SECTIONS |
        SourceIntents.SETTINGS_UI |
        SourceIntents.MANGA_TRACKING,
};
const SUPPORTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf'];
// Number of items requested for paged requests
const PAGE_SIZE = 40;
export const parseMangaStatus = (komgaStatus: string): string => {
    return komgaStatus.toLowerCase();
};
export const capitalize = (tag: string): string => {
    return tag.replace(/^\w/, (c) => c.toUpperCase());
};
export class KomgaRequestInterceptor implements SourceInterceptor {
    /*
        Requests made to Komga must use a Basic Authentication.
        This interceptor adds an authorization header to the requests.

        NOTE: The authorization header can be overridden by the request
        */
    stateManager: SourceStateManager;
    constructor(stateManager: SourceStateManager) {
        this.stateManager = stateManager;
    }
    async interceptResponse(response: Response): Promise<Response> {
        // console.log(`Response: ${JSON.stringify(response.data)} `);
        return response;
    }
    async interceptRequest(request: Request): Promise<Request> {
        // Paper's Note: This hack no longer works on iOS 17
        // ORIGINAL NOTE: Doing it like this will make downloads work tried every other method did not work, if there is a better method make edit it and make pull request
        // if (request.url.includes('intercept*')) {
        //     const url = request?.url?.split('*').pop() ?? ''
        //     request.headers = {
        //         'authorization': await getAuthorizationString(this.stateManager)
        //     }
        //     request.url = url
        //     return request
        // }
        if (request.headers === undefined) {
            request.headers = {};
        }

        // We mustn't call this.getAuthorizationString() for the stateful submission request.
        // This procedure indeed catchs the request used to check user credentials
        // which can happen before an authorizationString is saved,
        // raising an error in getAuthorizationString when we check for its existence
        // Thus we only inject an authorizationString if none are defined in the request
        if (request?.headers?.authorization == null) {
            request.headers.authorization = await getAuthorizationString(this.stateManager);
        }
        return request;
    }
}
export class Paperback extends Source implements MangaProgressProviding {
    stateManager = App.createSourceStateManager();
    requestManager = App.createRequestManager({
        requestsPerSecond: 5,
        requestTimeout: 20000,
        interceptor: new KomgaRequestInterceptor(this.stateManager),
    });
    override async getSourceMenu(): Promise<DUISection> {
        return App.createDUISection({
            id: 'main',
            header: 'Source Settings',
            isHidden: false,
            rows: async () => [
                serverSettingsMenu(this.stateManager),
                testServerSettingsMenu(this.stateManager, this.requestManager),
                resetSettingsButton(this.stateManager),
            ],
        });
    }
    override async getTags(): Promise<TagSection[]> {
        // This function is called on the homepage and should not throw if the server is unavailable
        // We define four types of tags:
        // - `genre`
        // - `tag`
        // - `collection`
        // - `library`
        // To be able to make the difference between theses types, we append `genre-` or `tag-` at the beginning of the tag id
        let genresResponse: Response, tagsResponse: Response, collectionResponse: Response, libraryResponse: Response;
        // We try to make the requests. If this fail, we return a placeholder tags list to inform the user and prevent the function from throwing an error
        try {
            const komgaAPI = await getKomgaAPI(this.stateManager);
            const genresRequest = App.createRequest({
                url: `${komgaAPI}/genres`,
                method: 'GET',
            });
            genresResponse = await this.requestManager.schedule(genresRequest, 1);
            const tagsRequest = App.createRequest({
                url: `${komgaAPI}/tags/series`,
                method: 'GET',
            });
            tagsResponse = await this.requestManager.schedule(tagsRequest, 1);
            const collectionRequest = App.createRequest({
                url: `${komgaAPI}/collections`,
                method: 'GET',
            });
            collectionResponse = await this.requestManager.schedule(collectionRequest, 1);
            const libraryRequest = App.createRequest({
                url: `${komgaAPI}/libraries`,
                method: 'GET',
            });
            libraryResponse = await this.requestManager.schedule(libraryRequest, 1);
        } catch (error) {
            console.log(`getTags failed with error: ${error}`);
            return [App.createTagSection({ id: '-1', label: 'Server unavailable', tags: [] })];
        }
        // The following part of the function should throw if there is an error and thus is not in the try/catch block
        const genresResult =
            typeof genresResponse.data === 'string' ? JSON.parse(genresResponse.data) : genresResponse.data;
        const tagsResult = typeof tagsResponse.data === 'string' ? JSON.parse(tagsResponse.data) : tagsResponse.data;
        const collectionResult =
            typeof collectionResponse.data === 'string' ? JSON.parse(collectionResponse.data) : collectionResponse.data;
        const libraryResult =
            typeof libraryResponse.data === 'string' ? JSON.parse(libraryResponse.data) : libraryResponse.data;
        const tagSections: [TagSection, TagSection, TagSection, TagSection] = [
            App.createTagSection({ id: '0', label: 'genres', tags: [] }),
            App.createTagSection({ id: '1', label: 'tags', tags: [] }),
            App.createTagSection({ id: '2', label: 'collections', tags: [] }),
            App.createTagSection({ id: '3', label: 'libraries', tags: [] }),
        ];
        // For each tag, we append a type identifier to its id and capitalize its label
        tagSections[0].tags = genresResult.map((elem: string) =>
            App.createTag({ id: 'genre-' + elem, label: capitalize(elem) }),
        );
        tagSections[1].tags = tagsResult.map((elem: string) =>
            App.createTag({ id: 'tag-' + elem, label: capitalize(elem) }),
        );
        tagSections[2].tags = collectionResult.content.map((elem: { name: string; id: string }) =>
            App.createTag({ id: 'collection-' + elem.id, label: capitalize(elem.name) }),
        );
        tagSections[3].tags = libraryResult.map((elem: { name: string; id: string }) =>
            App.createTag({ id: 'library-' + elem.id, label: capitalize(elem.name) }),
        );
        if (collectionResult.content.length <= 1) {
            tagSections.splice(2, 1);
        }
        return tagSections;
    }
    async getMangaDetails(mangaId: string): Promise<SourceManga> {
        /*
                In Komga a manga is represented by a `serie`
                */
        const komgaAPI = await getKomgaAPI(this.stateManager);
        const request = App.createRequest({
            url: `${komgaAPI}/series/${mangaId}`,
            method: 'GET',
        });
        const response = await this.requestManager.schedule(request, 1);
        const result = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
        const metadata = result.metadata;
        const booksMetadata = result.booksMetadata;
        const tagSections: [TagSection, TagSection] = [
            App.createTagSection({ id: '0', label: 'genres', tags: [] }),
            App.createTagSection({ id: '1', label: 'tags', tags: [] }),
        ];
        // For each tag, we append a type identifier to its id and capitalize its label
        tagSections[0].tags = metadata.genres.map((elem: string) =>
            App.createTag({ id: 'genre-' + elem, label: capitalize(elem) }),
        );
        tagSections[1].tags = metadata.tags.map((elem: string) =>
            App.createTag({ id: 'tag-' + elem, label: capitalize(elem) }),
        );
        const authors: string[] = [];
        const artists: string[] = [];
        // Additional roles: colorist, inker, letterer, cover, editor
        for (const entry of booksMetadata.authors) {
            if (entry.role === 'writer') {
                authors.push(entry.name);
            }
            if (entry.role === 'penciller') {
                artists.push(entry.name);
            }
        }
        return App.createSourceManga({
            id: mangaId,
            mangaInfo: App.createMangaInfo({
                titles: [metadata.title],
                image: `${komgaAPI}/series/${mangaId}/thumbnail`,
                status: parseMangaStatus(metadata.status),
                artist: artists.join(', '),
                author: authors.join(', '),
                desc: metadata.summary ? metadata.summary : booksMetadata.summary,
                tags: tagSections,
            }),
        });
    }
    async getChapters(mangaId: string): Promise<Chapter[]> {
        /*
                In Komga a chapter is a `book`
                */
        const komgaAPI = await getKomgaAPI(this.stateManager);
        const booksRequest = App.createRequest({
            url: `${komgaAPI}/series/${mangaId}/books`,
            param: '?unpaged=true&media_status=READY&deleted=false',
            method: 'GET',
        });
        const booksResponse = await this.requestManager.schedule(booksRequest, 1);
        const booksResult =
            typeof booksResponse.data === 'string' ? JSON.parse(booksResponse.data) : booksResponse.data;
        const chapters: Chapter[] = [];
        // Chapters language is only available on the serie page
        const serieRequest = App.createRequest({
            url: `${komgaAPI}/series/${mangaId}`,
            method: 'GET',
        });
        const serieResponse = await this.requestManager.schedule(serieRequest, 1);
        const serieResult =
            typeof serieResponse.data === 'string' ? JSON.parse(serieResponse.data) : serieResponse.data;
        const languageCode = parseLangCode(serieResult.metadata.language);
        for (const book of booksResult.content) {
            chapters.push(
                App.createChapter({
                    id: book.id,
                    chapNum: parseFloat(book.metadata.number),
                    langCode: languageCode,
                    name: `${book.metadata.title} (${book.size})`,
                    time: new Date(book.fileLastModified),
                    // @ts-ignore
                    sortingIndex: book.metadata.numberSort,
                }),
            );
        }
        return chapters;
    }
    async getChapterDetails(mangaId: string, chapterId: string): Promise<ChapterDetails> {
        const komgaAPI = await getKomgaAPI(this.stateManager);
        const request = App.createRequest({
            url: `${komgaAPI}/books/${chapterId}/pages`,
            method: 'GET',
        });
        const data = await this.requestManager.schedule(request, 1);
        const result = typeof data.data === 'string' ? JSON.parse(data.data) : data.data;
        const pages: string[] = [];
        for (const page of result) {
            if (SUPPORTED_IMAGE_TYPES.includes(page.mediaType)) {
                pages.push(`${komgaAPI}/books/${chapterId}/pages/${page.number}`);
            } else {
                pages.push(`${komgaAPI}/books/${chapterId}/pages/${page.number}?convert=png`);
            }
        }
        // Determine the preferred reading direction which is only available in the serie metadata
        const serieRequest = App.createRequest({
            url: `${komgaAPI}/series/${mangaId}`,
            method: 'GET',
        });
        const serieResponse = await this.requestManager.schedule(serieRequest, 1);
        const serieResult =
            typeof serieResponse.data === 'string' ? JSON.parse(serieResponse.data) : serieResponse.data;
        let longStrip = false;
        if (['VERTICAL', 'WEBTOON'].includes(serieResult.metadata.readingDirection)) {
            longStrip = true;
        }
        return App.createChapterDetails({
            id: chapterId,
            mangaId: mangaId,
            pages: pages,
        });
    }
    override async getSearchResults(searchQuery: SearchRequest, metadata: any): Promise<PagedResults> {
        // This function is also called when the user search in an other source. It should not throw if the server is unavailable.
        return searchRequest(searchQuery, metadata, this.requestManager, this.stateManager, PAGE_SIZE);
    }
    override async getHomePageSections(sectionCallback: (section: HomeSection) => void): Promise<void> {
        // This function is called on the homepage and should not throw if the server is unavailable
        // We won't use `await this.getKomgaAPI()` as we do not want to throw an error on
        // the homepage when server settings are not set
        const komgaAPI = await getKomgaAPI(this.stateManager);
        const { showOnDeck, showContinueReading } = await getOptions(this.stateManager);
        if (komgaAPI === null) {
            console.log('searchRequest failed because server settings are unset');
            const section = App.createHomeSection({
                id: 'unset',
                title: 'Go to source settings to set your Komga server credentials.',
                items: getServerUnavailableMangaTiles(),
                containsMoreItems: false,
                type: 'singleRowNormal',
            });
            sectionCallback(section);
            return;
        }
        // The source define two homepage sections: new and latest
        const sections = [];
        if (showOnDeck) {
            sections.push(
                App.createHomeSection({
                    id: 'ondeck',
                    title: 'On Deck',
                    containsMoreItems: false,
                    type: 'singleRowNormal',
                }),
            );
        }
        if (showContinueReading) {
            sections.push(
                App.createHomeSection({
                    id: 'continue',
                    title: 'Continue Reading',
                    containsMoreItems: false,
                    type: 'singleRowNormal',
                }),
            );
        }
        sections.push(
            App.createHomeSection({
                id: 'new',
                title: 'Recently added series',
                containsMoreItems: true,
                type: 'singleRowNormal',
            }),
        );
        sections.push(
            App.createHomeSection({
                id: 'updated',
                title: 'Recently updated series',
                containsMoreItems: true,
                type: 'singleRowNormal',
            }),
        );
        const promises: Promise<void>[] = [];
        for (const section of sections) {
            // Let the app load empty tagSections
            sectionCallback(section);
            let apiPath: string, thumbPath: string, params: string, idProp: string;
            switch (section.id) {
                case 'ondeck':
                    apiPath = `${komgaAPI}/books/${section.id}`;
                    thumbPath = `${komgaAPI}/books`;
                    params = '?page=0&size=20&deleted=false';
                    idProp = 'seriesId';
                    break;
                case 'continue':
                    apiPath = `${komgaAPI}/books`;
                    thumbPath = `${komgaAPI}/books`;
                    params = '?sort=readProgress.readDate,desc&read_status=IN_PROGRESS&page=0&size=20&deleted=false';
                    idProp = 'seriesId';
                    break;
                default:
                    apiPath = `${komgaAPI}/series/${section.id}`;
                    thumbPath = `${komgaAPI}/series`;
                    params = '?page=0&size=20&deleted=false';
                    idProp = 'id';
                    break;
            }
            const request = App.createRequest({
                url: apiPath,
                param: params,
                method: 'GET',
            });
            // Get the section data
            promises.push(
                this.requestManager.schedule(request, 1).then((data) => {
                    const result = typeof data.data === 'string' ? JSON.parse(data.data) : data.data;
                    const tiles = [];
                    for (const serie of result.content) {
                        tiles.push(
                            App.createPartialSourceManga({
                                title: serie.metadata.title,
                                image: `${thumbPath}/${serie.id}/thumbnail`,
                                mangaId: serie[idProp],
                                subtitle: undefined,
                            }),
                        );
                    }
                    section.items = tiles;
                    sectionCallback(section);
                }),
            );
        }
        // Make sure the function completes
        await Promise.all(promises);
    }
    override async getViewMoreItems(homepageSectionId: string, metadata: any): Promise<PagedResults> {
        const komgaAPI = await getKomgaAPI(this.stateManager);
        const page: number = metadata?.page ?? 0;
        const request = App.createRequest({
            url: `${komgaAPI}/series/${homepageSectionId}`,
            param: `?page=${page}&size=${PAGE_SIZE}&deleted=false`,
            method: 'GET',
        });
        const data = await this.requestManager.schedule(request, 1);
        const result = typeof data.data === 'string' ? JSON.parse(data.data) : data.data;
        const tiles: PartialSourceManga[] = [];
        for (const serie of result.content) {
            tiles.push(
                App.createPartialSourceManga({
                    title: serie.metadata.title,
                    image: `${komgaAPI}/series/${serie.id}/thumbnail`,
                    mangaId: serie.id,
                    subtitle: undefined,
                }),
            );
        }
        // If no series were returned we are on the last page
        metadata = tiles.length === 0 ? undefined : { page: page + 1 };
        return App.createPagedResults({
            results: tiles,
            metadata: metadata,
        });
    }

    async filterUpdatedManga(
        mangaUpdatesFoundCallback: (updates: MangaUpdates) => void,
        time: Date,
        ids: string[],
    ): Promise<void> {
        const komgaAPI = await getKomgaAPI(this.stateManager);
        // We make requests of PAGE_SIZE titles to `series/updated/` until we got every titles
        // or we got a title which `lastModified` metadata is older than `time`
        let page = 0;
        const foundIds: string[] = [];
        let loadMore = true;
        while (loadMore) {
            const request = App.createRequest({
                url: `${komgaAPI}/series/updated`,
                param: `?page=${page}&size=${PAGE_SIZE}&deleted=false`,
                method: 'GET',
            });
            const data = await this.requestManager.schedule(request, 1);
            const result = typeof data.data === 'string' ? JSON.parse(data.data) : data.data;
            for (const serie of result.content) {
                const serieUpdated = new Date(serie.metadata.lastModified);
                if (serieUpdated >= time) {
                    if (ids.includes(serie)) {
                        foundIds.push(serie);
                    }
                } else {
                    loadMore = false;
                    break;
                }
            }
            // If no series were returned we are on the last page
            if (result.content.length === 0) {
                loadMore = false;
            }
            page = page + 1;
            if (foundIds.length > 0) {
                mangaUpdatesFoundCallback(
                    App.createMangaUpdates({
                        ids: foundIds,
                    }),
                );
            }
        }
    }

    async getMangaProgress(mangaId: string): Promise<MangaProgress | undefined> {
        const komgaAPI = await getKomgaAPI(this.stateManager);
        if (komgaAPI == null) {
            console.log('Komga API is not set');
            return undefined;
        }

        const response = await this.requestManager.schedule(
            App.createRequest({
                url: `${komgaAPI}/series/${mangaId}/`,
                method: 'GET',
            }),
            1,
        );

        const result = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
        if (result?.booksCount == null) {
            return undefined;
        }

        return App.createMangaProgress({
            mangaId,
            lastReadChapterNumber: result.booksReadCount,
        });
    }

    async getMangaProgressManagementForm(mangaId: string): Promise<DUIForm> {
        const tempData: any = {}; // Temp solution, app is ass
        const komgaAPI = await getKomgaAPI(this.stateManager);

        return App.createDUIForm({
            sections: async () => {
                const request = App.createRequest({
                    url: `${komgaAPI}/series/${mangaId}`,
                    method: 'GET',
                });

                const response = await this.requestManager.schedule(request, 1);
                const result = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
                tempData.booksReadCount = result?.booksReadCount ?? 0;
                if (result?.id == null) {
                    return [
                        App.createDUISection({
                            id: 'komgaNotAvailableSection',
                            isHidden: false,
                            rows: async () => [
                                App.createDUILabel({
                                    id: 'komgaNotAvailable',
                                    label: 'Komga API is no set or available',
                                }),
                            ],
                        }),
                    ];
                }

                // if (anilistManga == null) {
                //     throw new Error(`Unable to find Manga on Anilist with id ${mangaId}`);
                // }

                return [
                    // Progress
                    App.createDUISection({
                        id: 'manage',
                        header: 'Progress',
                        isHidden: false,
                        rows: async () => [
                            App.createDUIStepper({
                                id: 'progress',
                                label: 'Chapter',
                                //@ts-ignore
                                value: result.booksReadCount ?? 0,
                                min: 0,
                                step: 1,
                                max: result.booksCount,
                            }),
                        ],
                    }),
                ];
            },
            onSubmit: async (values) => {
                if (values?.['progress'] == null || values?.['progress'] == tempData?.booksReadCount) {
                    // No changes
                    return;
                }

                const request = App.createRequest({
                    url: `${komgaAPI}/series/${mangaId}/books?unpaged=true`,
                    method: 'GET',
                });

                const response = await this.requestManager.schedule(request, 1);
                const result = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;

                if (result?.content == null) {
                    console.log('No data for series');
                    return;
                }

                // Setting all al unread first
                await this.requestManager.schedule(
                    App.createRequest({
                        url: `${komgaAPI}/series/${mangaId}/read-progress`,
                        method: 'DELETE',
                        headers: { 'content-type': 'application/json' },
                    }),
                    1,
                );

                for (const book of result.content) {
                    if (book.metadata.numberSort <= values['progress']) {
                        const request = App.createRequest({
                            url: `${komgaAPI}/books/${book.id}/read-progress`,
                            method: 'PATCH',
                            headers: { 'content-type': 'application/json' },
                            data: {
                                'page': null,
                                'completed': true,
                            },
                        });
                        await this.requestManager.schedule(request, 1);
                    }
                }

                return;
            },
        });
    }

    async processChapterReadActionQueue(actionQueue: TrackerActionQueue): Promise<void> {
        const chapterReadActions = await actionQueue.queuedChapterReadActions();

        const komgaAPI = await getKomgaAPI(this.stateManager);

        for (const readAction of chapterReadActions) {
            if (readAction.sourceId != 'Paperback') {
                console.log(
                    `Manga ${readAction.mangaId} from source ${readAction.sourceId} can not be used as it does not come from Komga. Discarding`,
                );
                await actionQueue.discardChapterReadAction(readAction);
            } else {
                try {
                    // The app only support completed read status so the last page read is not important and set to 1
                    const request = App.createRequest({
                        url: `${komgaAPI}/books/${readAction.sourceChapterId}/read-progress`,
                        method: 'PATCH',
                        headers: { 'content-type': 'application/json' },
                        data: {
                            'page': null,
                            'completed': true,
                        },
                    });

                    const response = await this.requestManager.schedule(request, 1);
                    console.log(
                        `Response for manga id ${readAction.mangaId} is ${response.status}: ${JSON.stringify(response.data)}`,
                    );

                    if (response.status < 400) {
                        await actionQueue.discardChapterReadAction(readAction);
                    } else {
                        await actionQueue.retryChapterReadAction(readAction);
                    }
                } catch (error) {
                    console.log(`Tracker action for manga id ${readAction.mangaId} failed with error:`);
                    console.log(error);
                    await actionQueue.retryChapterReadAction(readAction);
                }
            }
        }
    }
}
