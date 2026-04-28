const path = require('path');
const webpack = require('webpack');

module.exports = {
    entry: './src/ts/main.ts',
    module: {
        rules: [
            {
                test: /\.tsx?$/,
                use: 'ts-loader',
                exclude: /node_modules/,
            },
        ],
    },
    resolve: {
        extensions: ['.tsx', '.ts', '.js'],
        alias: {
            // axios >=1.7 imports 'process/browser' as a fully-specified ESM path;
            // map it to the concrete .js file so webpack can resolve it.
            'process/browser': require.resolve('process/browser.js'),
        },
        fallback: {
            stream: require.resolve('stream-browserify'),
            buffer: false,
        },
    },
    output: {
        filename: './bitmovin-player-mediatailor.js',
        path: path.join(__dirname, 'dist/js'),
        libraryTarget: 'umd',
        library: {
            amd: 'BitmovinMediaTailorPlayer',
            commonjs: 'BitmovinMediaTailorPlayer',
            root: ['bitmovin', 'player', 'ads', 'mediatailor'],
        },
    },
    target: ['web', 'es5'],
    plugins: [
        new webpack.ProvidePlugin({
            process: 'process/browser',
        }),
    ],
};
